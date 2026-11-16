import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context as ChordContext, JsonValue } from "@earendil-works/chord"
import type { ConversationId, DocumentReader, Harness, JsonObject, Tx } from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import type { IntakeService } from "../../src/contracts/intake.ts"
import {
  type AnsweredRequest,
  ASK_KIND,
  type AskInput,
  type AskOutcome,
  type OpenOutcome,
  type OpenQuestion,
  type OpenRequest,
  type QuestionsService,
  type RequestSubject,
  RequestsDoc,
  type Admitted,
  type RespondOutcome,
  type SettleOutcome,
} from "../../src/contracts/questions.ts"
import { spaceInScope, ThreadDoc, threadInScope, transition } from "../../src/contracts/threaddoc.ts"
import type { ThreadsService } from "../../src/contracts/threads.ts"
import type { WatchdogService } from "../../src/contracts/watchdog.ts"
import { DEFAULT_DEADLINE_MS, WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { CommandId } from "../../src/ids.ts"
import { type Actor, type Command, defineOp, type Op, OpRejected, type Outcome } from "../../src/ops.ts"

const context = BACKGROUND_CONTEXT
const DEFAULT_LISTED = 50
const MAX_LISTED = 200
/** Answers kept for the already-answered lookup: a retried respond arrives seconds after the first, not pages later. */
const MAX_ANSWERED = 20

type PendingRequest = {
  readonly id: string
  readonly kind: string
  readonly subject?: RequestSubject
  readonly conversationId: number
  readonly projectId: string
  readonly projectName: string
  readonly threadTitle?: string
  readonly question: string
  readonly options?: string[]
  readonly askedAt: number
}

type SettledRequest = {
  readonly id: string
  readonly kind: string
  readonly conversationId: number
  readonly answer: string
  readonly answeredAt: number
}

/** Refuses an answer this request does not take, or lets it through. */
type Admit = (open: OpenRequest) => void

const commandId = (value: string): CommandId => value as CommandId

export type QuestionsPort = {
  readonly harness: Harness
  readonly intake: Pick<IntakeService, "enqueue" | "withdraw">
  readonly threads: Pick<ThreadsService, "report">
  readonly watchdog: Pick<WatchdogService, "ensure">
  arm(): Promise<void>
  run(command: Command, actor: Actor): Promise<Outcome>
}

export function createQuestions(port: QuestionsPort): QuestionsService {
  return {
    async ask(input: AskInput, callContext: ChordContext): Promise<AskOutcome> {
      const thread = await port.harness.snapshot(ThreadDoc, input.threadId, callContext)
      if (thread === undefined) return { kind: "not_a_thread" }
      await port.harness.commit(async (tx) => {
        const requests = await tx.doc(RequestsDoc, input.threadId)
        if (requests.open[input.requestId] !== undefined) return
        requests.open[input.requestId] = {
          kind: input.kind,
          question: input.question,
          ...(input.options === undefined ? {} : { options: [...input.options] }),
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          at: input.now,
        }
        const doc = await tx.doc(ThreadDoc, input.threadId)
        if (doc.status === "working") doc.status = "waiting"
        doc.statusLine = "waiting for your answer"
      }, callContext)
      if (thread.parentId !== undefined) {
        const accepted = await port.intake.enqueue({
          target: thread.parentId as ConversationId,
          commandId: `question:${input.requestId}`,
          kind: "question",
          threadId: String(input.threadId),
          title: thread.title,
          status: "waiting",
          text: input.question,
        })
        if (accepted) await port.arm()
      }
      return { kind: "asked", requestId: input.requestId, question: input.question }
    },

    async open(conversationId: ConversationId): Promise<OpenOutcome> {
      const scope = await spaceInScope(port.harness, conversationId)
      if (scope === undefined) return { kind: "not_in_project" }
      return { kind: "open", questions: await openRequests(port.harness, scope.space.threadIds) }
    },

    async respond(api, threadId, requestId, reply): Promise<RespondOutcome> {
      const outcome = await port.run(
        {
          id: commandId(`request.respond:${api.taskId}`),
          op: "request.respond",
          args: { threadId, requestId, answer: reply },
        },
        { kind: "agent", conversationId: api.conversationId },
      )
      if (outcome.kind !== "ok") return { kind: "refused", message: outcome.message }
      return answerOutcome(outcome.result) ?? { kind: "refused", message: "The answer had no recognizable outcome." }
    },

    settle: (threadId, requestId, reply, admitted) =>
      settle(port, threadId, requestId, reply, () => undefined, admitted),
  }
}

/** A card takes only its options, and only from the owner: no agent may approve, connect or decline for them. */
const admitAnswer =
  (actor: Actor, reply: string): Admit =>
  (open) => {
    if (open.kind === ASK_KIND) return
    if (actor.kind !== "owner") throw new OpRejected("forbidden", `only the owner answers this ${open.kind} request`)
    if (!(open.options ?? []).includes(reply))
      throw new OpRejected("bad_args", `this ${open.kind} request takes only its own card's answers`)
  }

async function settle(
  port: QuestionsPort,
  threadId: ConversationId,
  requestId: string,
  reply: string,
  admit: Admit,
  admitted?: Admitted,
): Promise<SettleOutcome> {
  const stored = await port.harness.snapshot(ThreadDoc, threadId, context)
  if (stored === undefined) throw new OpRejected("bad_args", `no thread ${threadId}`)
  const now = Date.now()
  const outcome = await port.harness.commit(
    (tx) => answer(port, tx, threadId, stored.title, requestId, reply, now, admit, admitted),
    context,
  )
  if (outcome.kind === "answered") await port.intake.withdraw(`question:${requestId}`)
  return outcome
}

export function respondOp(port: QuestionsPort): Op {
  return defineOp({
    name: "request.respond",
    args: obj({
      threadId: int({ minimum: 0 }),
      requestId: str({ minLength: 1 }),
      answer: str({ minLength: 1, maxLength: 4_000 }),
    }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (
        api.actor.kind === "agent" &&
        (await threadInScope(api.harness, api.actor.conversationId, args.threadId)) === undefined
      )
        throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      const outcome = await settle(
        port,
        args.threadId as ConversationId,
        args.requestId,
        args.answer,
        admitAnswer(api.actor, args.answer),
      )
      return { threadId: args.threadId, requestId: args.requestId, ...outcome }
    },
  })
}

export function listOp(): Op {
  return defineOp({
    name: "request.list",
    read: true,
    args: obj({
      limit: opt(int({ minimum: 1, maximum: MAX_LISTED })),
      projectId: opt(str({ minLength: 1 })),
    }),
    actors: ["owner"],
    run: async (api, args) => {
      const limit = args.limit ?? DEFAULT_LISTED
      const listed = await listedRequests(api.harness, limit, args.projectId)
      return { requests: listed.pending.slice(0, limit), answered: listed.settled.slice(0, limit) }
    },
  })
}

/** The few pending questions the home carries, so its Needs You rows can answer without opening the Inbox. */
export const HOME_REQUESTS = 5

export async function homeRequests(harness: Harness, limit: number): Promise<JsonObject> {
  return { requests: (await listedRequests(harness, limit)).pending.slice(0, limit) }
}

type Keyed = { readonly conversationId: number; readonly id: string }

const order = (left: Keyed, right: Keyed): number =>
  left.conversationId - right.conversationId || left.id.localeCompare(right.id)

type Listed = { readonly pending: PendingRequest[]; readonly settled: SettledRequest[] }

/** Open requests of waiting threads and the answers each thread keeps, newest first, from one read of each thread. */
async function listedRequests(harness: Harness, limit: number, projectId?: string): Promise<Listed> {
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return { pending: [], settled: [] }
  const spaces = Object.entries(workspace.spaces).filter(([, space]) => {
    if (space.archived) return false
    const project = workspace.projects[space.projectId]
    if (project === undefined || project.archived) return false
    return projectId === undefined || projectId === space.projectId || projectId === project.slug
  })
  const perThread = await Promise.all(
    spaces.flatMap(([, space]) => {
      const project = workspace.projects[space.projectId]
      if (project === undefined) return []
      return space.threadIds.map(async (conversationId): Promise<Listed> => {
        const [requests, thread] = await Promise.all([
          harness.snapshot(RequestsDoc, conversationId as ConversationId, context),
          harness.snapshot(ThreadDoc, conversationId as ConversationId, context),
        ])
        if (requests === undefined) return { pending: [], settled: [] }
        const settled = Object.entries(requests.answered).map(([requestId, request]) => ({
          id: requestId,
          kind: request.kind,
          conversationId,
          answer: request.answer,
          answeredAt: request.answeredAt,
        }))
        if (thread?.status !== "waiting") return { pending: [], settled }
        const pending = Object.entries(requests.open).map(([requestId, request]) => ({
          id: requestId,
          kind: request.kind,
          conversationId,
          projectId: space.projectId,
          projectName: project.name,
          threadTitle: thread.title,
          question: request.question,
          ...(request.options === undefined ? {} : { options: [...request.options] }),
          ...(request.subject === undefined ? {} : { subject: request.subject }),
          askedAt: request.at,
        }))
        return { pending, settled }
      })
    }),
  )
  return {
    pending: perThread
      .flatMap((listed) => listed.pending)
      .toSorted((left, right) => right.askedAt - left.askedAt || order(left, right))
      .slice(0, limit),
    settled: perThread
      .flatMap((listed) => listed.settled)
      .toSorted((left, right) => right.answeredAt - left.answeredAt || order(left, right))
      .slice(0, limit),
  }
}

async function answer(
  port: QuestionsPort,
  tx: Tx,
  threadId: ConversationId,
  title: string,
  requestId: string,
  reply: string,
  now: number,
  admit: Admit,
  admitted: Admitted | undefined,
): Promise<SettleOutcome> {
  const requests = await tx.doc(RequestsDoc, threadId)
  const answered = requests.answered[requestId]
  if (answered !== undefined) return { kind: "already_answered", answer: answered.answer }
  const open = requests.open[requestId]
  if (open === undefined) throw new OpRejected("bad_args", `no request ${requestId}`)
  admit(open)
  const thread = await tx.doc(ThreadDoc, threadId)
  const next = transition(thread.status, "answer")
  if (next.kind !== "ok") throw new OpRejected("bad_args", next.reason)
  if (thread.parentId === undefined) throw new OpRejected("bad_args", `thread ${threadId} has no parent`)
  const parentId = thread.parentId as ConversationId
  await admitted?.(open)
  const workspace = await tx.doc(WorkspaceDoc)
  const project = workspace.projects[thread.projectId]
  const run = (thread.run ?? 1) + 1
  delete requests.open[requestId]
  requests.answered[requestId] = {
    kind: open.kind,
    question: open.question,
    ...(open.options === undefined ? {} : { options: open.options }),
    ...(open.subject === undefined ? {} : { subject: open.subject }),
    at: open.at,
    answer: reply,
    answeredAt: now,
  }
  trimAnswered(requests.answered)
  thread.status = "working"
  thread.run = run
  thread.statusLine = "running"
  thread.beatAt = now
  thread.deadlineAt = now + (project?.settings.deadlineMs ?? DEFAULT_DEADLINE_MS)
  delete thread.result
  await port.watchdog.ensure(tx, parentId)
  await port.threads.report(tx, {
    threadId,
    parentId,
    title,
    run,
    brief: reply,
    requestId: `answer:${threadId}:${requestId}`,
  })
  return { kind: "answered", run }
}

async function openRequests(read: DocumentReader, threadIds: readonly number[]): Promise<OpenQuestion[]> {
  const perThread = await Promise.all(
    threadIds.map(async (threadId): Promise<OpenQuestion[]> => {
      const conversationId = threadId as ConversationId
      const [thread, requests] = await Promise.all([
        read.snapshot(ThreadDoc, conversationId, context),
        read.snapshot(RequestsDoc, conversationId, context),
      ])
      if (thread === undefined || requests === undefined) return []
      if (thread.status !== "waiting") return []
      return Object.entries(requests.open).map(([requestId, request]) => ({
        threadId,
        requestId,
        title: thread.title,
        question: request.question,
        ...(request.options === undefined ? {} : { options: request.options }),
      }))
    }),
  )
  return perThread.flat()
}

function trimAnswered(answered: Record<string, AnsweredRequest>): void {
  const keys = Object.keys(answered)
  if (keys.length <= MAX_ANSWERED) return
  const oldest = keys.toSorted((left, right) => (answered[left]?.answeredAt ?? 0) - (answered[right]?.answeredAt ?? 0))
  for (const key of oldest.slice(0, keys.length - MAX_ANSWERED)) delete answered[key]
}

function answerOutcome(value: JsonValue): SettleOutcome | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const kind = Reflect.get(value, "kind")
  if (kind === "answered") {
    const run = Reflect.get(value, "run")
    return typeof run === "number" ? { kind: "answered", run } : undefined
  }
  if (kind === "already_answered") {
    const previous = Reflect.get(value, "answer")
    return typeof previous === "string" ? { kind: "already_answered", answer: previous } : undefined
  }
  return undefined
}
