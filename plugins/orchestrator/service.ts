import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context, JsonValue } from "@earendil-works/chord"
import type { Models } from "@earendil-works/pi-ai"
import type {
  ConversationId,
  ConversationHandle,
  DocumentReader,
  EntryId,
  Harness,
  ModelRef,
  Registry,
  Submission,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable"
import type {
  Caller,
  CallerProject,
  CapabilitiesOutcome,
  DelegateOutcome,
  DelegateRequest,
  ListOutcome,
  ReadOutcome,
  ReporterInput,
  SendMode,
  SendOutcome,
  StatusOutcome,
  StopOutcome,
  ThreadEntry,
  ThreadFilter,
  ThreadRole,
  ThreadsService,
  ThreadSummary,
} from "../../src/contracts/threads.ts"
import type { CommandId, ProjectId } from "../../src/ids.ts"
import { entryText, detailOf, textOf } from "../../src/transcript.ts"
import { resolveModel as resolveRoleModel, type ModelsService } from "../../src/contracts/models.ts"
import { projectInScope, ThreadDoc, threadInScope, type ThreadDocState } from "../../src/contracts/threaddoc.ts"
import { WorkspaceDoc, type ProjectState } from "../../src/contracts/workspace.ts"
import type { Actor, Command, Outcome } from "../../src/ops.ts"
import type { Threads } from "./threads.ts"

export type ServiceDeps = {
  readonly harness: Harness
  run(command: Command, actor: Actor): Promise<Outcome>
  currentModels(): Models
  readonly registry: Registry
  readonly models: ModelsService
}

const context = BACKGROUND_CONTEXT
const DEFAULT_WAIT_MS = 8_000
const CHILD_TOOLS = ["delegate_task", "task_cancel", "thread_send"] as const

type ProjectThreads = {
  readonly project: CallerProject
  readonly threads: readonly ThreadSummary[]
}

const projectOf = (projectId: string, project: ProjectState): CallerProject => ({
  projectId,
  name: project.name,
  threadLimit: project.settings.threadLimit,
})

const summaryOf = (id: number, doc: ThreadDocState): ThreadSummary => ({
  id,
  title: doc.title,
  status: doc.status,
  ...(doc.statusLine === undefined ? {} : { statusLine: doc.statusLine }),
  ...(doc.result === undefined ? {} : { result: doc.result }),
})

const commandId = (value: string): CommandId => value as CommandId

export function stringField(value: JsonValue | undefined, key: string): string | undefined {
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

const coordinator = async (
  read: DocumentReader,
  conversationId: ConversationId,
): Promise<CallerProject | undefined> => {
  const workspace = await read.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return undefined
  for (const [projectId, project] of Object.entries(workspace.projects)) {
    if (project.coordinatorId === conversationId) return projectOf(projectId, project)
  }
  return undefined
}

const threadsOf = async (read: DocumentReader, conversationId: ConversationId): Promise<ProjectThreads | undefined> => {
  const scope = await projectInScope(read, conversationId)
  if (scope === undefined) return undefined
  const found: ThreadSummary[] = []
  for (const id of scope.project.threadIds) {
    const doc = await read.snapshot(ThreadDoc, id as ConversationId, context)
    if (doc !== undefined) found.push(summaryOf(id, doc))
  }
  return { project: projectOf(scope.projectId, scope.project), threads: found }
}

const threadOf = async (
  read: DocumentReader,
  conversationId: ConversationId,
  threadId: number,
): Promise<ThreadSummary | undefined> => {
  const scope = await threadInScope(read, conversationId, threadId)
  return scope === undefined ? undefined : summaryOf(threadId, scope.doc)
}

export function threadService(deps: ServiceDeps, threads: Threads): ThreadsService {
  const models = () => deps.currentModels()

  const entriesOf = async (
    threadId: number,
    after: number | undefined,
    callContext: Context,
  ): Promise<readonly ThreadEntry[]> => {
    const conversation = await deps.harness.conversation(threadId as ConversationId, callContext)
    if (conversation === undefined) return []
    const page = await conversation.entries(
      { order: "ascending", ...(after === undefined ? {} : { minEntryId: (after + 1) as EntryId }) },
      200,
      undefined,
      callContext,
    )
    return page.items.map((entry) => ({ id: entry.id, text: entryText(entry) }))
  }

  const answerText = async (threadId: number, answer: EntryId, callContext: Context): Promise<string> => {
    const conversation = await deps.harness.conversation(threadId as ConversationId, callContext)
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
    const conversation = await deps.harness.conversation(threadId as ConversationId, callContext)
    if (conversation === undefined) return ""
    const page = await conversation.entries({ order: "descending" }, 40, undefined, callContext)
    const assistant = page.items.find((entry) => textOf(entry) !== "")
    return assistant === undefined ? "" : textOf(assistant)
  }

  const resolveModel = async (
    callerId: ConversationId,
    role: ThreadRole,
    project: CallerProject,
    target: ModelRef | undefined,
    callContext: Context,
  ): Promise<
    { readonly kind: "model"; readonly model: ModelRef } | { readonly kind: "none"; readonly reason: string }
  > => {
    if (target !== undefined) {
      if (models().getModel(target.provider, target.modelId) === undefined) {
        return {
          kind: "none",
          reason: `No model ${target.provider}/${target.modelId} is available. Pick another model.`,
        }
      }
      return { kind: "model", model: target }
    }
    const workspace = await deps.harness.snapshot(WorkspaceDoc, context)
    const defaults = workspace?.projects[project.projectId]?.settings.models
    const resolved = resolveRoleModel({
      role,
      ...(defaults === undefined ? {} : { project: defaults }),
      owner: await deps.models.ownerDefaults(),
    })
    if (resolved.kind === "model") return { kind: "model", model: resolved.model }
    const parent = await deps.harness.conversation(callerId, callContext)
    const parentModel = parent === undefined ? undefined : (await parent.agent(callContext)).model
    if (parentModel !== undefined) return { kind: "model", model: parentModel }
    return {
      kind: "none",
      reason:
        "No model is set for this project's threads. Pick a model (delegate_task target.model, the project's thread default, or the owner default), then try again.",
    }
  }

  const childRemovals = (): readonly ToolRegistration[] => {
    const registered = new Map(
      deps.registry
        .snapshot()
        .tools()
        .map(({ tool }) => [tool.name, tool]),
    )
    return CHILD_TOOLS.flatMap((name) => {
      const tool = registered.get(name)
      return tool === undefined ? [] : [tool]
    })
  }

  const delegate = async (caller: Caller, request: DelegateRequest, callContext: Context): Promise<DelegateOutcome> => {
    const harness = deps.harness
    const found = await coordinator(harness, caller.conversationId)
    if (found === undefined) return { kind: "not_coordinator" }
    const role: ThreadRole = request.role ?? "thread"
    const model = await resolveModel(caller.conversationId, role, found, request.model, callContext)
    if (model.kind === "none") return { kind: "no_model", reason: model.reason }
    const requestId = `delegate:${caller.conversationId}:${request.clientRequestId}`
    const created = await harness.commit(
      (tx: Tx) =>
        threads.createThread(tx, {
          projectId: found.projectId as ProjectId,
          parentId: caller.conversationId,
          title: request.title,
          role,
          task: request.task,
          model: model.model,
          clientRequestId: request.clientRequestId,
          requestId,
          removeTools: childRemovals(),
        }),
      callContext,
    )
    if (created.kind === "rejected") return { kind: "rejected", reason: created.reason }
    if (created.kind === "limit") return { kind: "limit", live: created.live, limit: created.limit }
    const conversation = await harness.conversation(created.threadId as ConversationId, callContext)
    if (created.kind === "existing") {
      await submitBrief(conversation, request.task, requestId, callContext)
      return { kind: "existing", threadId: created.threadId, title: created.title }
    }
    const submission = await submitBrief(conversation, request.task, requestId, callContext)
    if (submission === undefined) return { kind: "gone", threadId: created.threadId, title: created.title }
    if (request.mode === "async") return { kind: "started", threadId: created.threadId, title: created.title }
    const settled = await within(submission.wait(callContext), request.timeoutMs ?? DEFAULT_WAIT_MS)
    if (settled === undefined) return { kind: "timed_out", threadId: created.threadId, title: created.title }
    if (settled.status === "done") {
      const text = settled.type === "input" ? await answerText(created.threadId, settled.answer, callContext) : ""
      return { kind: "answered", threadId: created.threadId, title: created.title, text }
    }
    return {
      kind: "unanswered",
      threadId: created.threadId,
      title: created.title,
      reason: settled.detail === undefined ? settled.reason : detailOf(settled.detail),
    }
  }

  const status = async (caller: Caller, threadId: number, callContext: Context): Promise<StatusOutcome> => {
    const found = await threadOf(deps.harness, caller.conversationId, threadId)
    if (found === undefined) return { kind: "none" }
    return { kind: "thread", thread: found, last: await lastText(threadId, callContext) }
  }

  const stop = async (caller: Caller, threadId: number, reason: string | undefined): Promise<StopOutcome> => {
    if ((await threadOf(deps.harness, caller.conversationId, threadId)) === undefined) return { kind: "none" }
    const outcome = await deps.run(
      {
        id: commandId(`thread.stop:${caller.taskId}`),
        op: "thread.stop",
        args: { threadId, ...(reason === undefined ? {} : { reason }) },
      },
      { kind: "agent", conversationId: caller.conversationId },
    )
    return outcome.kind === "ok"
      ? { kind: "stopped", details: outcome.result }
      : { kind: "rejected", message: outcome.message }
  }

  const send = async (caller: Caller, threadId: number, text: string, mode: SendMode): Promise<SendOutcome> => {
    if ((await threadOf(deps.harness, caller.conversationId, threadId)) === undefined) return { kind: "none" }
    const outcome = await deps.run(
      { id: commandId(`thread.send:${caller.taskId}`), op: "thread.send", args: { threadId, text, mode } },
      { kind: "agent", conversationId: caller.conversationId },
    )
    if (outcome.kind !== "ok") return { kind: "rejected", message: outcome.message }
    return { kind: "sent", note: stringField(outcome.result, "note") ?? "Sent.", details: outcome.result }
  }

  const read = async (
    caller: Caller,
    threadId: number,
    after: number | undefined,
    callContext: Context,
  ): Promise<ReadOutcome> => {
    if ((await threadOf(deps.harness, caller.conversationId, threadId)) === undefined) return { kind: "none" }
    return {
      kind: "entries",
      entries: await entriesOf(threadId, after, callContext),
    }
  }

  const list = async (caller: Caller, filter: ThreadFilter): Promise<ListOutcome> => {
    const scope = await threadsOf(deps.harness, caller.conversationId)
    if (scope === undefined) return { kind: "not_in_project" }
    if (filter.projectId !== undefined && filter.projectId !== scope.project.projectId)
      return { kind: "no_project", projectId: filter.projectId }
    const matching =
      filter.status === undefined ? scope.threads : scope.threads.filter((thread) => thread.status === filter.status)
    return { kind: "threads", projectId: scope.project.projectId, threads: matching }
  }

  const capabilities = async (caller: Caller, callContext: Context): Promise<CapabilitiesOutcome> => {
    const conversation = await deps.harness.conversation(caller.conversationId, callContext)
    const agent = conversation === undefined ? undefined : await conversation.agent(callContext)
    const listed = (await models().getAvailable()).slice(0, 10).map((model) => `${model.provider}/${model.id}`)
    const found = await coordinator(deps.harness, caller.conversationId)
    const scope = found === undefined ? undefined : await threadsOf(deps.harness, caller.conversationId)
    const live = (scope?.threads ?? []).filter(
      (thread) => thread.status === "working" || thread.status === "waiting",
    ).length
    return {
      ...(agent?.model === undefined ? {} : { model: agent.model }),
      models: listed,
      ...(found === undefined ? {} : { project: { name: found.name, threadLimit: found.threadLimit, live } }),
    }
  }

  return {
    delegate,
    status,
    stop,
    send,
    read,
    list,
    capabilities,
    report: (tx: Tx, input: ReporterInput): Promise<void> => threads.report(tx, input),
  }
}
