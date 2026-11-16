import type { Context } from "@earendil-works/chord"
import {
  type ConversationId,
  defineDoc,
  defineTask,
  type DocumentReader,
  ProviderDoc,
  type Task,
  type Tx,
} from "@earendil-works/pi-durable"
import { int, lit, num, obj, opt, str, type Static, union } from "@earendil-works/pi-schema"
import { type BrowserBackend, type Machine, StartFailed } from "./backend.ts"

const TOUCH_MS = 60_000
const CLOSE_RETRY_MS = 5 * 60_000

const MachineSchema = obj({ id: str(), key: str() })
const Base = { generation: int({ minimum: 1 }), key: str(), usedAt: num() }
const SessionSchema = union([
  obj({ ...Base, state: lit("starting") }),
  obj({ ...Base, state: lit("running"), machine: MachineSchema }),
  obj({ ...Base, state: lit("closing"), machine: MachineSchema }),
  obj({ ...Base, state: lit("closed") }),
])
const BrowserSchema = obj({
  generation: int({ minimum: 0 }),
  session: opt(SessionSchema),
  act: opt(int({ minimum: 0 })),
})

export type BrowserState = Static<typeof BrowserSchema>
type Session = Static<typeof SessionSchema>

export const BrowserDoc = defineDoc<BrowserState>({
  kind: "xin.browser",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ generation: 0 }),
  checkpointWhen: () => false,
})

export type Docs = {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>
  snapshot: DocumentReader["snapshot"]
}

export type Scope = {
  readonly docs: Docs
  readonly conversationId: ConversationId
  readonly signal: AbortSignal
  readonly context: Context
}

type IdleInput = { readonly generation: number }
type IdleState = { readonly phase: "watch" } | { readonly phase: "close"; readonly machine: Machine }
export type IdleTask = Task<IdleInput, IdleState, null, object>

type Start = { readonly generation: number; readonly key: string }
type Plan = { readonly kind: "ready"; readonly machine: Machine } | { readonly kind: "start"; readonly start: Start }

export type Acting = { readonly machine: Machine; readonly replayed: boolean }

export type Sessions = {
  readonly idle: IdleTask
  open(scope: Scope): Promise<Machine>
  current(scope: Scope): Promise<Machine>
  act(scope: Scope, jobId: number): Promise<Acting>
  close(scope: Scope): Promise<boolean>
}

const keyOf = (identity: string, generation: number): string => `ingle-browser:${identity}:${generation}`

const sameGeneration = (session: Session | undefined, input: IdleInput): session is Session =>
  session !== undefined && session.generation === input.generation

const DONE = { status: "terminal", outcome: { status: "completed", result: null } } as const

const read = async (scope: Scope): Promise<Session | undefined> =>
  (await scope.docs.snapshot(BrowserDoc, scope.conversationId, scope.context))?.session

const fresh = (session: Session, now: number): boolean => now - session.usedAt < TOUCH_MS

const copy = (machine: Machine): Machine => ({ id: machine.id, key: machine.key })

const plan = (scope: Scope): Promise<Plan> =>
  scope.docs.commit(async (tx) => {
    const identity = (await tx.doc(ProviderDoc, scope.conversationId)).sessionId
    const doc = await tx.doc(BrowserDoc, scope.conversationId)
    const session = doc.session
    const now = Date.now()
    switch (session?.state) {
      case "running":
        doc.session = { ...session, usedAt: now }
        return { kind: "ready", machine: copy(session.machine) }
      case "starting":
        return { kind: "start", start: { generation: session.generation, key: session.key } }
      case undefined:
      case "closing":
      case "closed": {
        const generation = doc.generation + 1
        const key = keyOf(identity, generation)
        doc.generation = generation
        doc.session = { generation, key, usedAt: now, state: "starting" }
        return { kind: "start", start: { generation, key } }
      }
      default: {
        const _exhaustive: never = session
        return _exhaustive
      }
    }
  }, scope.context)

const settleFailure = (scope: Scope, start: Start): Promise<void> =>
  scope.docs.commit(async (tx) => {
    const doc = await tx.doc(BrowserDoc, scope.conversationId)
    if (sameGeneration(doc.session, start) && doc.session.state === "starting") delete doc.session
  }, scope.context)

export function createSessions(backend: BrowserBackend, idleMs: number): Sessions {
  const idleMinutes = Math.round(idleMs / 60_000)
  const closedText = `The browser was closed after ${idleMinutes} idle minutes. Call browser_open to start a new one.`

  const idle: IdleTask = defineTask<IdleInput, IdleState, null, object>({
    name: "xin.browser.idle",
    version: 1,
    initial: () => ({ phase: "watch" }),
    phases: {
      watch: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const doc = await tx.doc(BrowserDoc, runtime.conversationId)
          const session = doc.session
          if (!sameGeneration(session, task.input) || session.state !== "running") return DONE
          const due = session.usedAt + idleMs
          if (runtime.now() < due) return { status: "sleeping", until: due, checkpoint: { phase: "watch" } }
          doc.session = { ...session, state: "closing" }
          return { status: "running", checkpoint: { phase: "close", machine: copy(session.machine) } }
        }, context),
      close: async (task, runtime, context) => {
        try {
          await backend.close(task.state.checkpoint.machine, runtime.signal)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          runtime.report(error)
          await runtime.sleepUntil(runtime.now() + CLOSE_RETRY_MS, task.state.checkpoint, context)
          return
        }
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(BrowserDoc, runtime.conversationId)
          const session = doc.session
          if (sameGeneration(session, task.input) && session.state === "closing")
            doc.session = { generation: session.generation, key: session.key, usedAt: session.usedAt, state: "closed" }
          return DONE
        }, context)
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  })

  const launch = async (scope: Scope, start: Start): Promise<Machine> => {
    let machine: Machine
    try {
      machine = await backend.start({ key: start.key }, scope.signal)
    } catch (error) {
      if (error instanceof StartFailed) await settleFailure(scope, start)
      throw error
    }
    const kept = await scope.docs.commit(async (tx) => {
      const doc = await tx.doc(BrowserDoc, scope.conversationId)
      const session = doc.session
      if (!sameGeneration(session, start) || session.state === "closing" || session.state === "closed") return false
      if (session.state === "running") return true
      doc.session = { ...session, state: "running", machine, usedAt: Date.now() }
      await tx.createTask(
        idle,
        { generation: start.generation },
        { ownership: { kind: "conversation" }, conversationId: scope.conversationId, background: true },
      )
      return true
    }, scope.context)
    if (kept) return machine
    await backend.close(machine, scope.signal)
    throw new Error("the browser was closed while it was starting")
  }

  const ready = async (scope: Scope, act: number | undefined): Promise<Acting> => {
    const seen = await read(scope)
    if (seen === undefined) throw new Error("No browser is open in this conversation. Call browser_open first.")
    switch (seen.state) {
      case "starting":
        throw new Error(
          "The browser is not ready: browser_open has not finished. Call browser_open again if it failed.",
        )
      case "closing":
      case "closed":
        throw new Error(closedText)
      case "running":
        break
      default: {
        const _exhaustive: never = seen
        return _exhaustive
      }
    }
    if (act === undefined && fresh(seen, Date.now())) return { machine: seen.machine, replayed: false }
    const outcome = await scope.docs.commit(async (tx) => {
      const doc = await tx.doc(BrowserDoc, scope.conversationId)
      const session = doc.session
      if (!sameGeneration(session, seen) || session.state !== "running") return "closed"
      if (act !== undefined && doc.act === act) return "replayed"
      doc.session = { ...session, usedAt: Date.now() }
      if (act !== undefined) doc.act = act
      return "ready"
    }, scope.context)
    if (outcome === "closed") throw new Error(closedText)
    return { machine: seen.machine, replayed: outcome === "replayed" }
  }

  return {
    idle,

    async open(scope) {
      const seen = await read(scope)
      if (seen?.state === "running" && fresh(seen, Date.now())) return seen.machine
      const next = await plan(scope)
      switch (next.kind) {
        case "ready":
          return next.machine
        case "start":
          return launch(scope, next.start)
        default: {
          const _exhaustive: never = next
          return _exhaustive
        }
      }
    },

    current: async (scope) => (await ready(scope, undefined)).machine,

    act: (scope, jobId) => ready(scope, jobId),

    async close(scope) {
      const seen = await read(scope)
      if (seen === undefined || seen.state === "closed") return false
      if (seen.state !== "starting") await backend.close(seen.machine, scope.signal)
      await scope.docs.commit(async (tx) => {
        const doc = await tx.doc(BrowserDoc, scope.conversationId)
        if (doc.session?.generation === seen.generation) delete doc.session
      }, scope.context)
      return true
    },
  }
}
