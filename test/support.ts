import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  type FauxResponseFactory,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import { configure, type ConversationId, type ModelRef } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { expect } from "vitest"
import { M8_MODEL } from "./plugins/m8.ts"
import type { Home } from "./worker.ts"
import { ThreadDoc } from "../src/contracts/threaddoc.ts"
import { WorkspaceDoc } from "../src/contracts/workspace.ts"

export type Stub = DurableObjectStub<Home>

export const fresh = (): Stub => env.HOME.get(env.HOME.newUniqueId())

export type TestThread = { readonly id: ConversationId; readonly title: string }

/** Adds thread documents to an existing project, for tests that exercise thread-scoped behaviour. */
export async function addThreads(
  stub: Stub,
  projectId: string,
  titles: readonly string[],
  cwd?: string,
): Promise<readonly TestThread[]> {
  return runInDurableObject(stub, (home: Home) =>
    home.harness.commit(async (tx) => {
      const workspace = await tx.doc(WorkspaceDoc)
      const project = workspace.projects[projectId]
      if (project === undefined) throw new Error(`no project ${projectId}`)
      const created: TestThread[] = []
      for (const title of titles) {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } })
        await configure(tx, conversation.id, { model: M8_MODEL, cwd: cwd ?? `/projects/${project.slug}` })
        const doc = await tx.doc(ThreadDoc, conversation.id)
        const now = Date.now()
        Object.assign(doc, {
          projectId,
          title,
          role: "thread",
          status: "working",
          run: 1,
          beatAt: now,
          deadlineAt: now + project.settings.deadlineMs,
        })
        if (!project.threadIds.includes(conversation.id)) project.threadIds.push(conversation.id)
        created.push({ id: conversation.id, title })
      }
      return created
    }, BACKGROUND_CONTEXT),
  )
}

export type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

export const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

export const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

export const CLOCK_READING_PREFIX = "Time sampled while preparing turn "

export const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

type MessageLike = { readonly role: string; readonly content?: unknown }

const isOwnerMessage = (message: MessageLike): boolean =>
  message.role === "user" && !contentText(message.content).startsWith(CLOCK_READING_PREFIX)

export const lastOwnerIndex = (messages: readonly MessageLike[]): number => messages.findLastIndex(isOwnerMessage)

export const lastOwnerText = (messages: readonly MessageLike[]): string => {
  const owner = messages.findLast(isOwnerMessage)
  return owner === undefined ? "" : contentText(owner.content)
}

export const rowOf = async (stub: Stub, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${id}-${crypto.randomUUID()}`, "plugin.list")
  return Array.isArray(listed.result) ? listed.result.find((row) => field(row, "id") === id) : undefined
}

export const rowState = async (stub: Stub, id: string): Promise<unknown> => field(await rowOf(stub, id), "state")

export const setRow = async (stub: Stub, id: string, enabled: boolean): Promise<Ack> => {
  const ack = await cmd(stub, `${id}-${enabled}-${crypto.randomUUID()}`, "plugin.enable", { id, enabled })
  expect(ack.result).toMatchObject({ application: "applied", row: { disabled: !enabled } })
  return ack
}

export type Offer = { readonly tools: readonly string[]; readonly system: string }

export type OfferLog = {
  readonly seen: Offer[]
  wrap(factory: FauxResponseFactory): FauxResponseStep
  step(reply?: string): FauxResponseStep
  at(index: number): Offer
  latest(): Offer
}

export function offeredTools(context: TranscriptContext): string[] {
  const names = new Set<string>()
  for (const message of context.messages) {
    if (message.role !== "system") continue
    for (const removed of message.toolsRemoved ?? []) names.delete(removed.name)
    for (const added of message.toolsAdded ?? []) names.add(added.name)
  }
  return [...names].toSorted()
}

export function recordOffers(): OfferLog {
  const seen: Offer[] = []
  const at = (index: number): Offer => {
    const offer = seen[index]
    if (offer === undefined) throw new Error(`no request ${index} recorded`)
    return offer
  }
  const wrap =
    (factory: FauxResponseFactory): FauxResponseStep =>
    (context, options, state, model) => {
      seen.push({ tools: offeredTools(context), system: getCurrentSystemPrompt(context.messages) })
      return factory(context, options, state, model)
    }
  return {
    seen,
    wrap,
    step: (reply = "noted") => wrap(() => fauxAssistantMessage(reply)),
    at,
    latest: () => {
      const offer = seen.at(-1)
      if (offer === undefined) throw new Error("the faux model has not been called")
      return offer
    },
  }
}

export async function turn(
  stub: Stub,
  requestId: string,
  options: { text?: string; model?: ModelRef } = {},
): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(options.model ?? M8_MODEL)
    await home.submit(options.text ?? "go", requestId)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
  })
}

export async function eventually(
  stub: DurableObjectStub<Home>,
  check: (home: Home, state: DurableObjectState) => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await runInDurableObject(stub, check)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition not reached")
}

export const OWNER = "test-owner-token"
export const owner = (): DurableObjectStub<Home> => env.HOME.get(env.HOME.idFromName("owner"))

export const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new Request(`https://xin.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", ...init?.headers },
    }),
  )

export type Socket = {
  send(frame: unknown): void
  next(match: (frame: Frame) => boolean): Promise<Frame>
  close(): void
}
export type Frame = { readonly t?: string; readonly [key: string]: unknown }

export async function connect(): Promise<Socket> {
  const reply = await exports.default.fetch(
    new Request("https://xin.test/v1/socket", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `xin, bearer.${OWNER}` },
    }),
  )
  const ws = reply.webSocket
  if (ws === null) throw new Error(`no socket: ${reply.status}`)
  ws.accept()
  const frames: Frame[] = []
  const waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = []
  ws.addEventListener("message", (event) => {
    const frame: Frame = JSON.parse(String(event.data))
    const waiter = waiters.find((w) => w.match(frame))
    if (waiter === undefined) frames.push(frame)
    else {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(frame)
    }
  })
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (match) => {
      const index = frames.findIndex(match)
      if (index !== -1) return Promise.resolve(frames.splice(index, 1)[0] as Frame)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error("no matching frame within 5s")), 5000)
      })
    },
    close: () => ws.close(),
  }
}
