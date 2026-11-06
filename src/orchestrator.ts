import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context, JsonValue } from "@earendil-works/chord"
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type DocumentReader,
  type EntryId,
  type ModelRef,
  type Submission,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import type { CommandId, ProjectId } from "./ids.ts"
import { ModelRefSchema, ownerDefaults, resolveModel } from "./models.ts"
import type { HostModule, ModuleDeps } from "./module.ts"
import { lifecycle } from "./threads.ts"
import { projectInScope, ThreadDoc, threadInScope, type ThreadDocState, type ThreadRole } from "./threaddoc.ts"
import { detailOf, entryText, excerpt, textOf } from "./transcript.ts"
import { WorkspaceDoc, type ProjectState } from "./workspace.ts"

const context = BACKGROUND_CONTEXT
const MAX_READ_CHARS = 16_000
const DEFAULT_WAIT_MS = 8_000

const RoleSchema = oneOf(["chat", "thread", "utility"] as const)
const ModeSchema = oneOf(["async", "wait"] as const)
const SendModeSchema = oneOf(["steer", "queue"] as const)
const StatusSchema = oneOf(["working", "waiting", "completed", "failed", "cancelled"] as const)

type ThreadRecord = { readonly id: number; readonly doc: Readonly<ThreadDocState> }
type Coordinator = { readonly projectId: string; readonly project: ProjectState }
type ResolvedThreadModel =
  | { readonly kind: "model"; readonly model: ModelRef }
  | { readonly kind: "none"; readonly reason: string }

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

async function coordinatorOf(read: DocumentReader, conversationId: ConversationId): Promise<Coordinator | undefined> {
  const workspace = await read.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return undefined
  for (const [projectId, project] of Object.entries(workspace.projects)) {
    if (project.coordinatorId === conversationId) return { projectId, project }
  }
  return undefined
}

async function threadDocs(read: DocumentReader, project: ProjectState): Promise<ThreadRecord[]> {
  const found: ThreadRecord[] = []
  for (const id of project.threadIds) {
    const doc = await read.snapshot(ThreadDoc, id as ConversationId, context)
    if (doc !== undefined) found.push({ id, doc })
  }
  return found
}

const liveThreads = (docs: readonly ThreadRecord[]): ThreadRecord[] =>
  docs.filter(({ doc }) => doc.status === "working" || doc.status === "waiting")

export function create(deps: ModuleDeps): HostModule {
  const threads = lifecycle(deps)

  const submitBrief = async (
    threadId: number,
    brief: string,
    requestId: string,
    callContext: Context,
  ): Promise<Submission | undefined> => {
    const conversation = await deps.harness().conversation(threadId as ConversationId, callContext)
    if (conversation === undefined) return undefined
    return conversation.submit({ type: "input", content: brief, requestId }, callContext)
  }

  const answerText = async (threadId: number, answer: EntryId, callContext: Context): Promise<string> => {
    const conversation = await deps.harness().conversation(threadId as ConversationId, callContext)
    if (conversation === undefined) return ""
    const page = await conversation.entries(
      { minEntryId: answer, maxEntryId: answer, order: "ascending" },
      1,
      undefined,
      callContext,
    )
    return textOf(page.items[0])
  }

  const lastText = async (threadId: number, callContext: Context): Promise<string> => {
    const conversation = await deps.harness().conversation(threadId as ConversationId, callContext)
    if (conversation === undefined) return ""
    const page = await conversation.entries({ order: "descending" }, 40, undefined, callContext)
    const assistant = page.items.find((entry) => textOf(entry) !== "")
    return assistant === undefined ? "" : textOf(assistant)
  }

  const delegateModel = async (
    api: ToolExecutionApi,
    role: ThreadRole,
    project: ProjectState,
    target: ModelRef | undefined,
    callContext: Context,
  ): Promise<ResolvedThreadModel> => {
    if (target !== undefined) {
      if (api.models.getModel(target.provider, target.modelId) === undefined) {
        return {
          kind: "none",
          reason: `No model ${target.provider}/${target.modelId} is available. Pick another model.`,
        }
      }
      return { kind: "model", model: target }
    }
    const resolved = resolveModel({
      role,
      ...(project.settings.models === undefined ? {} : { project: project.settings.models }),
      owner: await ownerDefaults(deps.db),
    })
    if (resolved.kind === "model") return resolved
    const parent = await api.agent(callContext)
    if (parent.model !== undefined) return { kind: "model", model: parent.model }
    return {
      kind: "none",
      reason:
        "No model is set for this project's threads. Pick a model (delegate_task target.model, the project's thread default, or the owner default), then try again.",
    }
  }

  const capabilities = defineTool({
    name: "capabilities",
    description: "Show the current model, the project's thread limits, and the installed plugins.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      const agent = await api.agent(context)
      const found = await coordinatorOf(api, api.conversationId)
      const models = (await api.models.getAvailable()).slice(0, 10).map((model) => `${model.provider}/${model.id}`)
      const plugins = await deps.db.all<{ id: string; state: string }>(
        "SELECT id, state FROM plugins WHERE enabled = 1 ORDER BY id",
      )
      const lines = [
        `model: ${agent.model === undefined ? "none; pick a model" : `${agent.model.provider}/${agent.model.modelId}`}`,
        `models: ${models.length === 0 ? "none available" : models.join(", ")}`,
      ]
      if (found === undefined) {
        lines.push("project: none; this conversation is not a project coordinator")
      } else {
        const live = liveThreads(await threadDocs(api, found.project))
        lines.push(`project: ${found.project.name}`)
        lines.push(`threads: ${live.length} live of ${found.project.settings.threadLimit}`)
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
      const found = await coordinatorOf(api, api.conversationId)
      if (found === undefined) {
        return output("delegate_task is only available to a project coordinator.", {
          details: { code: "capability_denied" },
          isError: true,
        })
      }
      const requestId = `delegate:${api.conversationId}:${args.clientRequestId}`
      const role = args.role ?? "thread"
      const model = await delegateModel(api, role, found.project, args.target?.model, callContext)
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
      if (created.kind === "existing") {
        await submitBrief(created.threadId, args.task, requestId, callContext)
        return output(`Thread "${created.title}" (${created.threadId}) already exists for this request.`, {
          details: { threadId: created.threadId, title: created.title, replayed: true },
        })
      }
      const submission = await submitBrief(created.threadId, args.task, requestId, callContext)
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
          const text = settled.type === "input" ? await answerText(created.threadId, settled.answer, callContext) : ""
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
      const scope = await threadInScope(api, api.conversationId, args.threadId)
      if (scope === undefined) return output(`No thread ${args.threadId}.`, { isError: true })
      const doc = scope.doc
      const last = await lastText(args.threadId, callContext)
      const lines = [
        `thread ${args.threadId} "${doc.title}": ${doc.status}`,
        ...(doc.statusLine === undefined ? [] : [`status: ${doc.statusLine}`]),
        ...(doc.result === undefined ? [] : [`result: ${excerpt(doc.result, 400)}`]),
        ...(last === "" ? [] : [`last message: ${excerpt(last, 400)}`]),
      ]
      return output(lines.join("\n"), { details: { threadId: args.threadId, title: doc.title, status: doc.status } })
    },
  })

  const taskCancel = defineTool({
    name: "task_cancel",
    description: "Stop a thread's current run. The thread stays usable.",
    parameters: obj({ threadId: int({ minimum: 0 }), reason: opt(str({ maxLength: 500 })) }),
    replay: "unsafe",
    execute: async (args, api) => {
      if ((await threadInScope(api, api.conversationId, args.threadId)) === undefined)
        return output(`No thread ${args.threadId}.`, { isError: true })
      const outcome = await deps.run(
        {
          id: commandId(`thread.stop:${api.taskId}`),
          op: "thread.stop",
          args: { threadId: args.threadId, ...(args.reason === undefined ? {} : { reason: args.reason }) },
        },
        { kind: "agent", conversationId: api.conversationId },
      )
      if (outcome.kind !== "ok") return output(outcome.message, { isError: true })
      return output(`Stopped thread ${args.threadId}.`, { details: outcome.result })
    },
  })

  const threadSend = defineTool({
    name: "thread_send",
    description:
      "Send a message to a thread. Steer interrupts, queue waits for the current answer. A finished thread starts a new run.",
    parameters: obj({ threadId: int({ minimum: 0 }), text: str({ minLength: 1 }), mode: SendModeSchema }),
    replay: "safe",
    execute: async (args, api) => {
      if ((await threadInScope(api, api.conversationId, args.threadId)) === undefined)
        return output(`No thread ${args.threadId}.`, { isError: true })
      const outcome = await deps.run(
        {
          id: commandId(`thread.send:${api.taskId}`),
          op: "thread.send",
          args: { threadId: args.threadId, text: args.text, mode: args.mode },
        },
        { kind: "agent", conversationId: api.conversationId },
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
      if ((await threadInScope(api, api.conversationId, args.threadId)) === undefined)
        return output(`No thread ${args.threadId}.`, { isError: true })
      const conversation = await deps.harness().conversation(args.threadId as ConversationId, callContext)
      if (conversation === undefined) return output(`No thread ${args.threadId}.`, { isError: true })
      const page = await conversation.entries(
        {
          order: "ascending",
          ...(args.after === undefined ? {} : { minEntryId: (args.after + 1) as EntryId }),
        },
        200,
        undefined,
        callContext,
      )
      const lines: string[] = []
      let chars = 0
      let last = args.after
      for (const entry of page.items) {
        const text = entryText(entry)
        if (text === "") {
          last = entry.id
          continue
        }
        const line = `[${entry.id}] ${text}`
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
      const scope = await projectInScope(api, api.conversationId)
      if (scope === undefined) return output("This conversation is not in a project.", { isError: true })
      if (args.projectId !== undefined && args.projectId !== scope.projectId)
        return output(`No project ${args.projectId} in this conversation.`, { isError: true })
      const lines: string[] = []
      const listed: JsonValue[] = []
      for (const record of await threadDocs(api, scope.project)) {
        if (args.status !== undefined && record.doc.status !== args.status) continue
        lines.push(
          `${record.id} [${record.doc.status}] ${record.doc.title}${record.doc.result === undefined ? "" : ` — ${excerpt(record.doc.result)}`}`,
        )
        listed.push({
          id: record.id,
          projectId: scope.projectId,
          title: record.doc.title,
          status: record.doc.status,
          ...(record.doc.result === undefined ? {} : { result: excerpt(record.doc.result) }),
        })
      }
      return output(lines.length === 0 ? "No threads." : lines.join("\n"), { details: { threads: listed } })
    },
  })

  const childTools: readonly ToolRegistration[] = [delegate, taskCancel, threadSend]

  const extension = defineExtension({
    name: "xin.orchestrator",
    tools: [capabilities, delegate, taskStatus, taskCancel, threadSend, threadRead, threadList],
    tasks: [threads.anchor, threads.reporter],
  })

  return {
    extensions: [extension],
    ops: threads.ops,
  }
}
