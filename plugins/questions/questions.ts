import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import type { ConversationId, DocumentReader, Tx } from "@earendil-works/pi-durable"
import { int, obj, str } from "@earendil-works/pi-schema"
import type { AskRecord, OpenQuestion, QuestionsService, RespondOutcome } from "../../src/contracts/questions.ts"
import type { CommandId } from "../../src/ids.ts"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { defineOp, OpRejected } from "../../src/ops.ts"
import { enqueue } from "../intake/gateway.ts"
import { reporterTask } from "../orchestrator/threads.ts"
import { ensureWatchdogTx, watchdogTask, type WatchdogTask } from "../watchdog/watchdog.ts"
import { projectInScope, ThreadDoc, threadInScope, transition } from "../workspace/threaddoc.ts"
import { DEFAULT_DEADLINE_MS, RequestsDoc, WorkspaceDoc } from "../workspace/workspace.ts"

const context = BACKGROUND_CONTEXT

type AnswerOutcome =
  | { readonly kind: "answered"; readonly run: number }
  | { readonly kind: "already_answered"; readonly answer: string }

const commandId = (value: string): CommandId => value as CommandId

export function create(deps: ModuleDeps): HostModule {
  const reporter = reporterTask({ db: deps.db, arm: () => deps.arm(), harness: () => deps.harness() })
  const watchdog = watchdogTask(deps)

  const questions: QuestionsService = {
    async ask(api, callContext, input): Promise<AskRecord | undefined> {
      const threadId = api.conversationId
      const thread = await api.snapshot(ThreadDoc, threadId, callContext)
      if (thread === undefined) return undefined
      const requestId = `q:${api.taskId}`
      const now = api.now()
      await api.commit(async (tx) => {
        const requests = await tx.doc(RequestsDoc, threadId)
        if (requests.open[requestId] !== undefined) return
        requests.open[requestId] = {
          kind: "ask_user",
          question: input.question,
          ...(input.options === undefined ? {} : { options: [...input.options] }),
          at: now,
        }
        const doc = await tx.doc(ThreadDoc, threadId)
        if (doc.status === "working") doc.status = "waiting"
        doc.statusLine = "waiting for your answer"
      }, callContext)
      if (thread.parentId !== undefined) {
        const accepted = await enqueue(
          deps.db,
          {
            target: thread.parentId as ConversationId,
            commandId: `question:${requestId}`,
            kind: "question",
            threadId: String(threadId),
            title: thread.title,
            status: "waiting",
            text: input.question,
          },
          now,
        )
        if (accepted) await deps.arm()
      }
      return { requestId, question: input.question }
    },

    async open(api): Promise<readonly OpenQuestion[] | undefined> {
      const scope = await projectInScope(api, api.conversationId)
      if (scope === undefined) return undefined
      return openRequests(api, scope.project.threadIds)
    },

    async respond(api, threadId, requestId, reply): Promise<RespondOutcome> {
      const outcome = await deps.run(
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

  const respondOp = defineOp({
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
        (tx) => answer(tx, watchdog, threadId, stored.title, args.requestId, args.answer, now),
        context,
      )
      if (outcome.kind === "answered") {
        await deps.db.run(
          "DELETE FROM inbound WHERE command_id = ? AND status = 'pending'",
          `question:${args.requestId}`,
        )
        await deps.arm()
      }
      return { threadId: args.threadId, requestId: args.requestId, ...outcome }
    },
  })

  async function answer(
    tx: Tx,
    watchdogDef: WatchdogTask,
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
    await ensureWatchdogTx(tx, watchdogDef, parentId)
    await tx.createTask(
      reporter,
      {
        threadId,
        parentId,
        title,
        run,
        brief: reply,
        requestId: `answer:${threadId}:${requestId}`,
      },
      { ownership: { kind: "conversation" }, conversationId: parentId, background: true },
    )
    return { kind: "answered", run }
  }

  return { provides: { questions }, ops: [respondOp] }
}

async function openRequests(read: DocumentReader, threadIds: readonly number[]): Promise<OpenQuestion[]> {
  const found: OpenQuestion[] = []
  for (const threadId of threadIds) {
    const conversationId = threadId as ConversationId
    const thread = await read.snapshot(ThreadDoc, conversationId, context)
    if (thread === undefined) continue
    const requests = await read.snapshot(RequestsDoc, conversationId, context)
    if (requests === undefined) continue
    for (const [requestId, request] of Object.entries(requests.open)) {
      found.push({
        threadId,
        requestId,
        title: thread.title,
        question: request.question,
        ...(request.options === undefined ? {} : { options: request.options }),
      })
    }
  }
  return found
}

function answerOutcome(value: JsonValue): AnswerOutcome | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const kind = Reflect.get(value, "kind")
  if (kind === "answered") {
    const run = Reflect.get(value, "run")
    return typeof run === "number" ? { kind: "answered", run } : undefined
  }
  if (kind === "already_answered") {
    const answer = Reflect.get(value, "answer")
    return typeof answer === "string" ? { kind: "already_answered", answer } : undefined
  }
  return undefined
}
