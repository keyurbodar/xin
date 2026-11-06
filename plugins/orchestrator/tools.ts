import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context, JsonValue } from "@earendil-works/chord"
import {
  type ConversationHandle,
  type ConversationId,
  defineExtension,
  defineTool,
  type Submission,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import { ModelRefSchema, type ThreadsService } from "../../src/contracts/threads.ts"
import type { CommandId, ProjectId } from "../../src/ids.ts"
import type { Context as KernelContext } from "../../src/kernel/index.ts"
import { detailOf, excerpt } from "../../src/transcript.ts"

const context = BACKGROUND_CONTEXT
const MAX_READ_CHARS = 16_000
const DEFAULT_WAIT_MS = 8_000

const RoleSchema = oneOf(["chat", "thread", "utility"] as const)
const ModeSchema = oneOf(["async", "wait"] as const)
const SendModeSchema = oneOf(["steer", "queue"] as const)
const StatusSchema = oneOf(["working", "waiting", "completed", "failed", "cancelled"] as const)

const commandId = (value: string): CommandId => value as CommandId

function output(
  text: string,
  extra: { readonly details?: JsonValue; readonly isError?: boolean } = {},
): ToolExecutionResult {
  return {
    output: [{ type: "text", text }],
    ...(extra.details === undefined ? {} : { details: extra.details }),
    ...(extra.isError === true ? { isError: true } : {}),
  }
}

function stringData(value: JsonValue | undefined, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === "string" ? found : undefined
}

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

const submitBrief = (
  conversation: ConversationHandle | undefined,
  brief: string,
  requestId: string,
  callContext: Context,
): Promise<Submission | undefined> =>
  conversation === undefined
    ? Promise.resolve(undefined)
    : conversation.submit({ type: "input", content: brief, requestId }, callContext)

function tools(threads: ThreadsService): readonly ToolRegistration[] {
  const capabilities = defineTool({
    name: "capabilities",
    description: "Show the current model, the project's thread limits, and the installed plugins.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      const agent = await api.agent(context)
      const found = await threads.coordinator(api, api.conversationId)
      const models = (await api.models.getAvailable()).slice(0, 10).map((model) => `${model.provider}/${model.id}`)
      const plugins = await threads.enabledPlugins()
      const lines = [
        `model: ${agent.model === undefined ? "none; pick a model" : `${agent.model.provider}/${agent.model.modelId}`}`,
        `models: ${models.length === 0 ? "none available" : models.join(", ")}`,
      ]
      if (found === undefined) {
        lines.push("project: none; this conversation is not a project coordinator")
      } else {
        const scope = await threads.threadsOf(api, api.conversationId)
        const live = (scope?.threads ?? []).filter(
          (thread) => thread.status === "working" || thread.status === "waiting",
        )
        lines.push(`project: ${found.name}`)
        lines.push(`threads: ${live.length} live of ${found.threadLimit}`)
      }
      lines.push(
        `plugins: ${plugins.length === 0 ? "none" : plugins.map((plugin) => `${plugin.id} (${plugin.state})`).join(", ")}`,
      )
      return output(lines.join("\n"))
    },
  })

  const delegate = defineTool({
    name: "delegate_task",
    description:
      "Delegate a self-contained brief to a background thread in this project. The thread sees only the brief and its role. Its result arrives later as a report.",
    parameters: obj({
      task: str({ minLength: 1 }),
      title: str({ minLength: 1, maxLength: 200 }),
      role: opt(RoleSchema),
      target: opt(obj({ model: ModelRefSchema })),
      mode: ModeSchema,
      timeoutMs: opt(int({ minimum: 1, maximum: DEFAULT_WAIT_MS })),
      clientRequestId: str({ minLength: 1 }),
    }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      const found = await threads.coordinator(api, api.conversationId)
      if (found === undefined) {
        return output("delegate_task is only available to a project coordinator.", {
          details: { code: "capability_denied" },
          isError: true,
        })
      }
      const requestId = `delegate:${api.conversationId}:${args.clientRequestId}`
      const role = args.role ?? "thread"
      const model = await threads.resolveModel(api, role, found, args.target?.model, callContext)
      if (model.kind === "none") return output(model.reason, { details: { code: "no_model" }, isError: true })
      const created = await api.commit(
        (tx) =>
          threads.createThread(tx, {
            projectId: found.projectId as ProjectId,
            parentId: api.conversationId,
            title: args.title,
            role,
            task: args.task,
            model: model.model,
            clientRequestId: args.clientRequestId,
            requestId,
            removeTools: childTools,
          }),
        callContext,
      )
      if (created.kind === "rejected") return output(created.reason, { isError: true })
      if (created.kind === "limit") {
        const listed = created.live.map((thread) => `${thread.title} (${thread.id}, ${thread.status})`)
        return output(
          `limit_reached: ${created.live.length} live threads of ${created.limit}. Running: ${listed.join(", ")}. Wait for one to finish or raise the project's threadLimit.`,
          { details: { code: "limit_reached", limit: created.limit, threads: [...created.live] }, isError: true },
        )
      }
      const conversation = await api.conversation(created.threadId as ConversationId, callContext)
      if (created.kind === "existing") {
        await submitBrief(conversation, args.task, requestId, callContext)
        return output(`Thread "${created.title}" (${created.threadId}) already exists for this request.`, {
          details: { threadId: created.threadId, title: created.title, replayed: true },
        })
      }
      const submission = await submitBrief(conversation, args.task, requestId, callContext)
      if (submission === undefined) return output("The thread conversation is gone.", { isError: true })
      if (args.mode === "wait") {
        const settled = await within(submission.wait(callContext), args.timeoutMs ?? DEFAULT_WAIT_MS)
        if (settled === undefined) {
          return output(
            `Thread "${created.title}" (${created.threadId}) is still running. Its result will arrive as a report.`,
            {
              details: { threadId: created.threadId, title: created.title, mode: "wait", timedOut: true },
            },
          )
        }
        if (settled.status === "done") {
          const text =
            settled.type === "input" ? await threads.answerText(created.threadId, settled.answer, callContext) : ""
          return output(`Thread "${created.title}" answered: ${text || "(no text)"}`, {
            details: { threadId: created.threadId, title: created.title, status: "completed" },
          })
        }
        return output(
          `Thread "${created.title}" did not answer: ${settled.detail === undefined ? settled.reason : detailOf(settled.detail)}`,
          {
            details: { threadId: created.threadId, title: created.title, status: "failed" },
            isError: true,
          },
        )
      }
      return output(`Started thread "${created.title}" (${created.threadId}). Its result will arrive as a report.`, {
        details: { threadId: created.threadId, title: created.title, mode: "async" },
      })
    },
  })

  const taskStatus = defineTool({
    name: "task_status",
    description: "Read a thread's status and its latest text.",
    parameters: obj({ threadId: int({ minimum: 0 }) }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      const found = await threads.threadOf(api, api.conversationId, args.threadId)
      if (found === undefined) return output(`No thread ${args.threadId}.`, { isError: true })
      const last = await threads.lastText(args.threadId, callContext)
      const lines = [
        `thread ${args.threadId} "${found.title}": ${found.status}`,
        ...(found.statusLine === undefined ? [] : [`status: ${found.statusLine}`]),
        ...(found.result === undefined ? [] : [`result: ${excerpt(found.result, 400)}`]),
        ...(last === "" ? [] : [`last message: ${excerpt(last, 400)}`]),
      ]
      return output(lines.join("\n"), {
        details: { threadId: args.threadId, title: found.title, status: found.status },
      })
    },
  })

  const taskCancel = defineTool({
    name: "task_cancel",
    description: "Stop a thread's current run or a job. Give exactly one of threadId or jobId.",
    parameters: obj({
      threadId: opt(int({ minimum: 0 })),
      jobId: opt(int({ minimum: 0 })),
      reason: opt(str({ maxLength: 500 })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const target =
        args.threadId !== undefined && args.jobId === undefined
          ? { kind: "thread" as const, threadId: args.threadId }
          : args.jobId !== undefined && args.threadId === undefined
            ? { kind: "job" as const, jobId: args.jobId }
            : undefined
      if (target === undefined) return output("task_cancel needs exactly one of threadId or jobId.", { isError: true })
      if (target.kind === "job") {
        if (!(await threads.cancelJob(api.conversationId, target.jobId)))
          return output(`No job ${target.jobId}.`, { isError: true })
        return output(`Stopped job ${target.jobId}.`, { details: { jobId: target.jobId } })
      }
      if ((await threads.threadOf(api, api.conversationId, target.threadId)) === undefined)
        return output(`No thread ${target.threadId}.`, { isError: true })
      const outcome = await threads.stopThread(
        api.conversationId,
        target.threadId,
        args.reason,
        commandId(`thread.stop:${api.taskId}`),
      )
      if (outcome.kind !== "ok") return output(outcome.message, { isError: true })
      return output(`Stopped thread ${target.threadId}.`, { details: outcome.result })
    },
  })

  const threadSend = defineTool({
    name: "thread_send",
    description:
      "Send a message to a thread. Steer interrupts, queue waits for the current answer. A finished thread starts a new run.",
    parameters: obj({ threadId: int({ minimum: 0 }), text: str({ minLength: 1 }), mode: SendModeSchema }),
    replay: "safe",
    execute: async (args, api) => {
      if ((await threads.threadOf(api, api.conversationId, args.threadId)) === undefined)
        return output(`No thread ${args.threadId}.`, { isError: true })
      const outcome = await threads.sendToThread(
        api.conversationId,
        args.threadId,
        args.text,
        args.mode,
        commandId(`thread.send:${api.taskId}`),
      )
      if (outcome.kind !== "ok") return output(outcome.message, { isError: true })
      return output(stringData(outcome.result, "note") ?? "Sent.", { details: outcome.result })
    },
  })

  const threadRead = defineTool({
    name: "thread_read",
    description: "Read a thread's text after an entry id. Bounded to about 4k tokens.",
    parameters: obj({ threadId: int({ minimum: 0 }), after: opt(int({ minimum: 0 })) }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      if ((await threads.threadOf(api, api.conversationId, args.threadId)) === undefined)
        return output(`No thread ${args.threadId}.`, { isError: true })
      const page = await threads.readThread(args.threadId, args.after, callContext)
      const lines: string[] = []
      let chars = 0
      let last = args.after
      for (const entry of page) {
        if (entry.text === "") {
          last = entry.id
          continue
        }
        const line = `[${entry.id}] ${entry.text}`
        if (chars + line.length > MAX_READ_CHARS) {
          if (lines.length === 0) {
            lines.push(`${line.slice(0, MAX_READ_CHARS)}…`)
            last = entry.id
          } else {
            lines.push("… truncated")
          }
          break
        }
        lines.push(line)
        chars += line.length
        last = entry.id
      }
      return output(lines.length === 0 ? "No text after that entry." : lines.join("\n"), {
        details: { threadId: args.threadId, ...(last === undefined ? {} : { after: last }) },
      })
    },
  })

  const threadList = defineTool({
    name: "thread_list",
    description: "List this project's threads, optionally by status.",
    parameters: obj({ projectId: opt(str({ minLength: 1 })), status: opt(StatusSchema) }),
    replay: "safe",
    execute: async (args, api) => {
      const scope = await threads.threadsOf(api, api.conversationId)
      if (scope === undefined) return output("This conversation is not in a project.", { isError: true })
      if (args.projectId !== undefined && args.projectId !== scope.project.projectId)
        return output(`No project ${args.projectId} in this conversation.`, { isError: true })
      const lines: string[] = []
      const listed: JsonValue[] = []
      for (const record of scope.threads) {
        if (args.status !== undefined && record.status !== args.status) continue
        lines.push(
          `${record.id} [${record.status}] ${record.title}${record.result === undefined ? "" : ` — ${excerpt(record.result)}`}`,
        )
        listed.push({
          id: record.id,
          projectId: scope.project.projectId,
          title: record.title,
          status: record.status,
          ...(record.result === undefined ? {} : { result: excerpt(record.result) }),
        })
      }
      return output(lines.length === 0 ? "No threads." : lines.join("\n"), { details: { threads: listed } })
    },
  })

  const childTools: readonly ToolRegistration[] = [delegate, taskCancel, threadSend]

  return [capabilities, delegate, taskStatus, taskCancel, threadSend, threadRead, threadList]
}

export const name = "tool-orchestrator"
export const inject = ["pi", "threads"]

export function apply(ctx: KernelContext): void {
  ctx.pi.install(defineExtension({ name, tools: tools(ctx.threads) }))
}
