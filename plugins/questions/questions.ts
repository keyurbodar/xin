import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context as ChordContext, JsonValue } from "@earendil-works/chord"
import type { ConversationId, DocumentReader, Harness, Tx } from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import type { IntakeService } from "../../src/contracts/intake.ts"
import {
  type AskInput,
  type AskOutcome,
  type OpenOutcome,
  type OpenQuestion,
  type QuestionsService,
  RequestsDoc,
  type RespondOutcome,
} from "../../src/contracts/questions.ts"
import { projectInScope, ThreadDoc, threadInScope, transition } from "../../src/contracts/threaddoc.ts"
import type { ThreadsService } from "../../src/contracts/threads.ts"
import type { WatchdogService } from "../../src/contracts/watchdog.ts"
import { DEFAULT_DEADLINE_MS, WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { CommandId } from "../../src/ids.ts"
import { type Actor, type Command, defineOp, type Op, OpRejected, type Outcome } from "../../src/ops.ts"

const context = BACKGROUND_CONTEXT
const DEFAULT_LISTED = 50
const MAX_LISTED = 200

type PendingRequest = {
  readonly id: string
  readonly conversationId: number
  readonly projectId: string
  readonly projectName: string
  readonly threadTitle?: string
  readonly question: string
  readonly options?: string[]
  readonly askedAt: number
}

type AnswerOutcome =
  | { readonly kind: "answered"; readonly run: number }
  | { readonly kind: "already_answered"; readonly answer: string }

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
          kind: "ask_user",
          question: input.question,
          ...(input.options === undefined ? {} : { options: [...input.options] }),
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
      const scope = await projectInScope(port.harness, conversationId)
      if (scope === undefined) return { kind: "not_in_project" }
      return { kind: "open", questions: await openRequests(port.harness, scope.project.threadIds) }
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
  }
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
      const threadId = args.threadId as ConversationId
      const stored = await api.harness.snapshot(ThreadDoc, threadId, context)
      if (stored === undefined) throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      const now = Date.now()
      const outcome = await api.harness.commit(
        (tx) => answer(port, tx, threadId, stored.title, args.requestId, args.answer, now),
        context,
      )
      if (outcome.kind === "answered") await port.intake.withdraw(`question:${args.requestId}`)
      return { threadId: args.threadId, requestId: args.requestId, ...outcome }
    },
  })
}

export function listOp(): Op {
  return defineOp({
    name: "request.list",
    args: obj({
      limit: opt(int({ minimum: 1, maximum: MAX_LISTED })),
      projectId: opt(str({ minLength: 1 })),
    }),
    actors: ["owner"],
    run: async (api, args) => {
      const limit = args.limit ?? DEFAULT_LISTED
      const workspace = await api.harness.snapshot(WorkspaceDoc, context)
      const projects = Object.entries(workspace?.projects ?? {}).filter(
        ([projectId, project]) => !project.archived && (args.projectId === undefined || args.projectId === projectId),
      )
      const perProject = await Promise.all(
        projects.map(async ([projectId, project]) =>
          (
            await Promise.all(
              project.threadIds.map(async (conversationId): Promise<PendingRequest[]> => {
                const [requests, thread] = await Promise.all([
                  api.harness.snapshot(RequestsDoc, conversationId as ConversationId, context),
                  api.harness.snapshot(ThreadDoc, conversationId as ConversationId, context),
                ])
                if (requests === undefined) return []
                return Object.entries(requests.open).map(([requestId, request]) => ({
                  id: requestId,
                  conversationId,
                  projectId,
                  projectName: project.name,
                  ...(thread === undefined ? {} : { threadTitle: thread.title }),
                  question: request.question,
                  ...(request.options === undefined ? {} : { options: [...request.options] }),
                  askedAt: request.at,
                }))
              }),
            )
          ).flat(),
        ),
      )
      const listed = perProject
        .flat()
        .toSorted(
          (left, right) =>
            right.askedAt - left.askedAt ||
            left.conversationId - right.conversationId ||
            left.id.localeCompare(right.id),
        )
      return { requests: listed.slice(0, limit) }
    },
  })
}

async function answer(
  port: QuestionsPort,
  tx: Tx,
  threadId: ConversationId,
  title: string,
  requestId: string,
  reply: string,
  now: number,
): Promise<AnswerOutcome> {
  const requests = await tx.doc(RequestsDoc, threadId)
  const answered = requests.answered[requestId]
  if (answered !== undefined) return { kind: "already_answered", answer: answered.answer }
  const open = requests.open[requestId]
  if (open === undefined) throw new OpRejected("bad_args", `no request ${requestId}`)
  const thread = await tx.doc(ThreadDoc, threadId)
  const next = transition(thread.status, "answer")
  if (next.kind !== "ok") throw new OpRejected("bad_args", next.reason)
  if (thread.parentId === undefined) throw new OpRejected("bad_args", `thread ${threadId} has no parent`)
  const parentId = thread.parentId as ConversationId
  const workspace = await tx.doc(WorkspaceDoc)
  const project = workspace.projects[thread.projectId]
  const run = (thread.run ?? 1) + 1
  delete requests.open[requestId]
  requests.answered[requestId] = {
    kind: open.kind,
    question: open.question,
    ...(open.options === undefined ? {} : { options: open.options }),
    at: open.at,
    answer: reply,
    answeredAt: now,
  }
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

function answerOutcome(value: JsonValue): AnswerOutcome | undefined {
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
