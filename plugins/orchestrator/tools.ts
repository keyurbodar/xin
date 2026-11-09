import type { JsonValue } from "@earendil-works/chord"
import {
  defineExtension,
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import { ModelRefSchema } from "../../src/contracts/models.ts"
import {
  SendModeSchema,
  type Caller,
  type DelegateOutcome,
  type SendOutcome,
  type ThreadsService,
} from "../../src/contracts/threads.ts"
import { RoleSchema, StatusSchema } from "../../src/contracts/threaddoc.ts"
import { type Context as KernelContext, textResult } from "../../src/kernel/index.ts"
import { excerpt } from "../../src/transcript.ts"

const MAX_READ_CHARS = 16_000
const MAX_WAIT_MS = 8_000

const ModeSchema = oneOf(["async", "wait"] as const)

const callerOf = (api: ToolExecutionApi): Caller => ({
  conversationId: api.conversationId,
  taskId: String(api.taskId),
})

function delegated(outcome: DelegateOutcome): ToolExecutionResult {
  switch (outcome.kind) {
    case "not_coordinator":
      return textResult("delegate_task is only available to a project coordinator.", {
        details: { code: "capability_denied" },
        isError: true,
      })
    case "no_model":
      return textResult(outcome.reason, { details: { code: "no_model" }, isError: true })
    case "limit": {
      const listed = outcome.live.map((thread) => `${thread.title} (${thread.id}, ${thread.status})`)
      return textResult(
        `limit_reached: ${outcome.live.length} live threads of ${outcome.limit}. Running: ${listed.join(", ")}. Wait for one to finish or raise the project's threadLimit.`,
        { details: { code: "limit_reached", limit: outcome.limit, threads: [...outcome.live] }, isError: true },
      )
    }
    case "rejected":
      return textResult(outcome.reason, { isError: true })
    case "existing":
      return textResult(`Thread "${outcome.title}" (${outcome.threadId}) already exists for this request.`, {
        details: { threadId: outcome.threadId, title: outcome.title, replayed: true },
      })
    case "started":
      return textResult(
        `Started thread "${outcome.title}" (${outcome.threadId}). Its result will arrive as a report.`,
        {
          details: { threadId: outcome.threadId, title: outcome.title, mode: "async" },
        },
      )
    case "timed_out":
      return textResult(
        `Thread "${outcome.title}" (${outcome.threadId}) is still running. Its result will arrive as a report.`,
        { details: { threadId: outcome.threadId, title: outcome.title, mode: "wait", timedOut: true } },
      )
    case "answered":
      return textResult(`Thread "${outcome.title}" answered: ${outcome.text || "(no text)"}`, {
        details: { threadId: outcome.threadId, title: outcome.title, status: "completed" },
      })
    case "unanswered":
      return textResult(`Thread "${outcome.title}" did not answer: ${outcome.reason}`, {
        details: { threadId: outcome.threadId, title: outcome.title, status: "failed" },
        isError: true,
      })
    case "gone":
      return textResult("The thread conversation is gone.", { isError: true })
  }
}

function sent(outcome: SendOutcome, threadId: number): ToolExecutionResult {
  switch (outcome.kind) {
    case "none":
      return textResult(`No thread ${threadId}.`, { isError: true })
    case "rejected":
      return textResult(outcome.message, { isError: true })
    case "sent":
      return textResult(outcome.note, { details: outcome.details })
  }
}

function tools(ctx: KernelContext): readonly ToolRegistration[] {
  const threads: ThreadsService = ctx.threads

  const capabilities = defineTool({
    name: "capabilities",
    description: "Show the current model, the project's thread limits, and the installed plugins.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api, callContext) => {
      const viewed = await threads.capabilities(callerOf(api), callContext)
      const plugins = (await ctx.get("plugins")?.list()) ?? []
      const lines = [
        `model: ${viewed.model === undefined ? "none; pick a model" : `${viewed.model.provider}/${viewed.model.modelId}`}`,
        `models: ${viewed.models.length === 0 ? "none available" : viewed.models.join(", ")}`,
      ]
      if (viewed.project === undefined) {
        lines.push("project: none; this conversation is not a project coordinator")
      } else {
        lines.push(`project: ${viewed.project.name}`)
        lines.push(`threads: ${viewed.project.live} live of ${viewed.project.threadLimit}`)
      }
      if (viewed.puck !== undefined) {
        lines.push(
          viewed.puck.projects.length === 0
            ? "projects: none"
            : `projects: ${viewed.puck.projects.map((project) => `${project.slug} (${project.live} live)`).join(", ")}`,
        )
      }
      lines.push(
        `plugins: ${plugins.length === 0 ? "none" : plugins.map((plugin) => `${plugin.id} (${plugin.state.kind})`).join(", ")}`,
      )
      return textResult(lines.join("\n"))
    },
  })

  const delegate = defineTool({
    name: "delegate_task",
    description:
      "Delegate a self-contained brief to a background thread. In a Space the thread runs in the Space's project; Puck must name one with project. The thread sees only the brief and its role. Its result arrives later as a report.",
    parameters: obj({
      task: str({ minLength: 1 }),
      title: str({ minLength: 1, maxLength: 200 }),
      role: opt(RoleSchema),
      project: opt(str({ minLength: 1, maxLength: 200 })),
      target: opt(obj({ model: ModelRefSchema })),
      mode: ModeSchema,
      timeoutMs: opt(int({ minimum: 1, maximum: MAX_WAIT_MS })),
      clientRequestId: str({ minLength: 1 }),
    }),
    replay: "safe",
    execute: async (args, api, callContext) =>
      delegated(
        await threads.delegate(
          callerOf(api),
          {
            task: args.task,
            title: args.title,
            mode: args.mode,
            clientRequestId: args.clientRequestId,
            ...(args.role === undefined ? {} : { role: args.role }),
            ...(args.project === undefined ? {} : { project: args.project }),
            ...(args.target?.model === undefined ? {} : { model: args.target.model }),
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          },
          callContext,
        ),
      ),
  })

  const taskStatus = defineTool({
    name: "task_status",
    description: "Read a thread's status and its latest text.",
    parameters: obj({ threadId: int({ minimum: 0 }) }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      const found = await threads.status(callerOf(api), args.threadId, callContext)
      if (found.kind === "none") return textResult(`No thread ${args.threadId}.`, { isError: true })
      const lines = [
        `thread ${args.threadId} "${found.thread.title}": ${found.thread.status}`,
        ...(found.thread.statusLine === undefined ? [] : [`status: ${found.thread.statusLine}`]),
        ...(found.thread.result === undefined ? [] : [`result: ${excerpt(found.thread.result, 400)}`]),
        ...(found.last === "" ? [] : [`last message: ${excerpt(found.last, 400)}`]),
      ]
      return textResult(lines.join("\n"), {
        details: { threadId: args.threadId, title: found.thread.title, status: found.thread.status },
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
      if (target === undefined)
        return textResult("task_cancel needs exactly one of threadId or jobId.", { isError: true })
      if (target.kind === "job") {
        if (!(await ctx.jobs.cancel(api.conversationId, target.jobId)))
          return textResult(`No job ${target.jobId}.`, { isError: true })
        return textResult(`Stopped job ${target.jobId}.`, { details: { jobId: target.jobId } })
      }
      const outcome = await threads.stop(callerOf(api), target.threadId, args.reason)
      switch (outcome.kind) {
        case "none":
          return textResult(`No thread ${target.threadId}.`, { isError: true })
        case "rejected":
          return textResult(outcome.message, { isError: true })
        case "stopped":
          return textResult(`Stopped thread ${target.threadId}.`, { details: outcome.details })
      }
    },
  })

  const threadSend = defineTool({
    name: "thread_send",
    description:
      "Send a message to a thread. Steer interrupts, queue waits for the current answer. A finished thread starts a new run.",
    parameters: obj({ threadId: int({ minimum: 0 }), text: str({ minLength: 1 }), mode: SendModeSchema }),
    replay: "safe",
    execute: async (args, api) =>
      sent(await threads.send(callerOf(api), args.threadId, args.text, args.mode), args.threadId),
  })

  const threadRead = defineTool({
    name: "thread_read",
    description: "Read a thread's text after an entry id. Bounded to about 4k tokens.",
    parameters: obj({ threadId: int({ minimum: 0 }), after: opt(int({ minimum: 0 })) }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      const found = await threads.read(callerOf(api), args.threadId, args.after, callContext)
      if (found.kind === "none") return textResult(`No thread ${args.threadId}.`, { isError: true })
      const lines: string[] = []
      let chars = 0
      let last = args.after
      for (const entry of found.entries) {
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
      return textResult(lines.length === 0 ? "No text after that entry." : lines.join("\n"), {
        details: { threadId: args.threadId, ...(last === undefined ? {} : { after: last }) },
      })
    },
  })

  const threadList = defineTool({
    name: "thread_list",
    description:
      "List threads. A Space sees its own project; Puck sees every project, optionally filtered by project slug.",
    parameters: obj({ projectId: opt(str({ minLength: 1 })), status: opt(StatusSchema) }),
    replay: "safe",
    execute: async (args, api) => {
      const found = await threads.list(callerOf(api), {
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.status === undefined ? {} : { status: args.status }),
      })
      switch (found.kind) {
        case "not_in_project":
          return textResult("This conversation is not in a project.", { isError: true })
        case "no_project":
          return textResult(`No project ${found.projectId} in this conversation.`, { isError: true })
        case "threads": {
          const lines: string[] = []
          const listed: JsonValue[] = []
          for (const record of found.threads) {
            lines.push(
              `${record.id} [${record.status}] ${record.title}${record.result === undefined ? "" : ` — ${excerpt(record.result)}`}`,
            )
            listed.push({
              id: record.id,
              projectId: found.projectId,
              title: record.title,
              status: record.status,
              ...(record.result === undefined ? {} : { result: excerpt(record.result) }),
            })
          }
          return textResult(lines.length === 0 ? "No threads." : lines.join("\n"), { details: { threads: listed } })
        }
        case "all": {
          const lines: string[] = []
          const listed: JsonValue[] = []
          for (const record of found.threads) {
            lines.push(
              `${record.id} [${record.status}] ${record.projectId} — ${record.title}${record.result === undefined ? "" : ` — ${excerpt(record.result)}`}`,
            )
            listed.push({
              id: record.id,
              projectId: record.projectId,
              title: record.title,
              status: record.status,
              ...(record.result === undefined ? {} : { result: excerpt(record.result) }),
            })
          }
          return textResult(lines.length === 0 ? "No threads." : lines.join("\n"), { details: { threads: listed } })
        }
      }
    },
  })

  const threadCreate = defineTool({
    name: "thread_create",
    description:
      "Start a thread directly in a project's default space or a named space. The owner and Puck use this; a space coordinator uses delegate_task.",
    parameters: obj({
      title: str({ minLength: 1, maxLength: 200 }),
      task: str({ minLength: 1 }),
      role: opt(RoleSchema),
      project: opt(str({ minLength: 1 })),
      spaceId: opt(str({ minLength: 1 })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const created = await threads.create(callerOf(api), {
        title: args.title,
        task: args.task,
        ...(args.role === undefined ? {} : { role: args.role }),
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.spaceId === undefined ? {} : { spaceId: args.spaceId }),
      })
      if (created.kind === "rejected") return textResult(created.message, { isError: true })
      const threadId =
        typeof created.result === "object" && created.result !== null
          ? Reflect.get(created.result, "threadId")
          : undefined
      return textResult(
        `Started thread ${typeof threadId === "number" ? threadId : "?"}. Its result will arrive as a report.`,
        { details: created.result },
      )
    },
  })

  return [capabilities, delegate, threadCreate, taskStatus, taskCancel, threadSend, threadRead, threadList]
}

export const name = "tool-orchestrator"
export const inject = ["pi", "threads", "jobs"]

export function apply(ctx: KernelContext): void {
  ctx.pi.install(defineExtension({ name, tools: tools(ctx) }))
}
