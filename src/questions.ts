import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import type { ConversationId, DocumentReader, Tx } from "@earendil-works/pi-durable"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import { enqueue } from "./gateway.ts"
import type { CommandId } from "./ids.ts"
import type { HostModule, ModuleDeps } from "./module.ts"
import { defineOp, OpRejected } from "./ops.ts"
import { projectInScope, ThreadDoc, threadInScope, transition } from "./threaddoc.ts"
import { reporterTask } from "./threads.ts"
import { ensureWatchdogTx, watchdogTask, type WatchdogTask } from "./watchdog.ts"
import { DEFAULT_DEADLINE_MS, RequestsDoc, WorkspaceDoc } from "./workspace.ts"

const context = BACKGROUND_CONTEXT
const ActionSchema = oneOf(["list", "read", "respond"] as const)

export type OpenRequest = {
  readonly threadId: number
  readonly requestId: string
  readonly title: string
  readonly question: string
  readonly options?: readonly string[]
}

type AnswerOutcome =
  | { readonly kind: "answered"; readonly run: number }
  | { readonly kind: "already_answered"; readonly answer: string }

const commandId = (value: string): CommandId => value as CommandId

function output(text: string, extra: { readonly isError?: boolean; readonly details?: JsonValue } = {}) {
  return {
    output: [{ type: "text" as const, text }],
    ...(extra.details === undefined ? {} : { details: extra.details }),
    ...(extra.isError === true ? { isError: true } : {}),
  }
}

export function create(deps: ModuleDeps): HostModule {
  const reporter = reporterTask({ db: deps.db, arm: () => deps.arm(), harness: () => deps.harness() })
  const watchdog = watchdogTask(deps)

  const askUser = defineTool({
    name: "ask_user",
    description:
      "Ask the owner a question and end your turn. The answer starts your next run. Ask only when you are blocked.",
    parameters: obj({
      question: str({ minLength: 1, maxLength: 2_000 }),
      options: opt(arr(str({ minLength: 1, maxLength: 200 }), { maxItems: 8 })),
    }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      const threadId = api.conversationId
      const thread = await api.snapshot(ThreadDoc, threadId, callContext)
      if (thread === undefined) return output("ask_user is only available inside a thread.", { isError: true })
      const requestId = `q:${api.taskId}`
      const now = api.now()
      await api.commit(async (tx) => {
        const requests = await tx.doc(RequestsDoc, threadId)
        if (requests.open[requestId] !== undefined) return
        requests.open[requestId] = {
          kind: "ask_user",
          question: args.question,
          ...(args.options === undefined ? {} : { options: [...args.options] }),
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
            text: args.question,
          },
          now,
        )
        if (accepted) await deps.arm()
      }
      return {
        output: [{ type: "text", text: `Asked the owner: ${args.question}` }],
        details: { requestId, question: args.question },
        control: { terminate: true },
      }
    },
  })

  const pendingRequest = defineTool({
    name: "pending_request",
    description: "List, read, or answer a thread's open question.",
    parameters: obj({
      action: ActionSchema,
      threadId: opt(int({ minimum: 0 })),
      requestId: opt(str({ minLength: 1 })),
      answer: opt(str({ minLength: 1, maxLength: 4_000 })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const scope = await projectInScope(api, api.conversationId)
      if (scope === undefined) return output("This conversation is not in a project.", { isError: true })
      const open = await openRequests(api, scope.project.threadIds)
      switch (args.action) {
        case "list": {
          if (open.length === 0) return output("No open questions.")
          return output(
            open.map((request) => `${request.threadId} "${request.title}": ${request.question}`).join("\n"),
            { details: { requests: open.map(plain) } },
          )
        }
        case "read": {
          const found = pick(open, args.threadId, args.requestId)
          if (found === undefined) return output("No matching open question.", { isError: true })
          return output(`${found.title} asks: ${found.question}`, { details: plain(found) })
        }
        case "respond": {
          if (args.answer === undefined) return output("respond needs an answer.", { isError: true })
          const found = pick(open, args.threadId, args.requestId)
          if (found === undefined) return output("No matching open question.", { isError: true })
          const outcome = await deps.run(
            {
              id: commandId(`request.respond:${api.taskId}`),
              op: "request.respond",
              args: { threadId: found.threadId, requestId: found.requestId, answer: args.answer },
            },
            { kind: "agent", conversationId: api.conversationId },
          )
          if (outcome.kind !== "ok") return output(outcome.message, { isError: true })
          const answered = answerOutcome(outcome.result)
          if (answered === undefined) return output("The answer had no recognizable outcome.", { isError: true })
          switch (answered.kind) {
            case "answered":
              return output(`Answered ${found.requestId}. The thread is running again.`, {
                details: outcome.result,
              })
            case "already_answered":
              return output(`already_answered: ${answered.answer}`, { details: outcome.result })
          }
        }
        default: {
          const _exhaustive: never = args.action
          return _exhaustive
        }
      }
    },
  })

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

  return {
    extensions: [defineExtension({ name: "xin.questions", tools: [askUser, pendingRequest] })],
    ops: [respondOp],
  }
}

async function openRequests(read: DocumentReader, threadIds: readonly number[]): Promise<OpenRequest[]> {
  const found: OpenRequest[] = []
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

function pick(
  open: readonly OpenRequest[],
  threadId: number | undefined,
  requestId: string | undefined,
): OpenRequest | undefined {
  const matching = open.filter(
    (request) =>
      (threadId === undefined || request.threadId === threadId) &&
      (requestId === undefined || request.requestId === requestId),
  )
  return matching.length === 1 ? matching[0] : undefined
}

function plain(request: OpenRequest): JsonValue {
  return {
    threadId: request.threadId,
    requestId: request.requestId,
    title: request.title,
    question: request.question,
    ...(request.options === undefined ? {} : { options: [...request.options] }),
  }
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
