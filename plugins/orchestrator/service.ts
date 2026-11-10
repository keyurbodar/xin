import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context, JsonValue } from "@earendil-works/chord"
import type { Models } from "@earendil-works/pi-ai"
import type {
  ConversationId,
  ConversationHandle,
  EntryId,
  Harness,
  ModelRef,
  Registry,
  Submission,
  Tx,
} from "@earendil-works/pi-durable"
import type {
  Caller,
  CallerProject,
  CapabilitiesOutcome,
  CreateThreadOutcome,
  CreateThreadRequest,
  DelegateOutcome,
  DelegateRequest,
  ListedThread,
  ListOutcome,
  PuckProject,
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
import { ThreadDoc, defaultSpaceOf, type ThreadDocState } from "../../src/contracts/threaddoc.ts"
import { canUseThread, projectByRef, scopeOf, type Scope } from "../../src/contracts/scope.ts"
import { WorkspaceDoc, type ProjectState } from "../../src/contracts/workspace.ts"
import type { Actor, Command, Outcome } from "../../src/ops.ts"
import { childTools, type Threads } from "./threads.ts"

export type ServiceDeps = {
  readonly harness: Harness
  run(command: Command, actor: Actor): Promise<Outcome>
  currentModels(): Models
  readonly registry: Registry
  readonly models: ModelsService
}

const context = BACKGROUND_CONTEXT
const DEFAULT_WAIT_MS = 8_000

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

/** Live slots are running threads: one waiting on a question holds no slot, so it cannot block a project. */
const liveCount = async (harness: Harness, threadIds: readonly number[]): Promise<number> => {
  let live = 0
  for (const id of threadIds) {
    const doc = await harness.snapshot(ThreadDoc, id as ConversationId, context)
    if (doc?.status === "working") live += 1
  }
  return live
}

const threadOf = async (
  harness: Harness,
  callerId: ConversationId,
  threadId: number,
): Promise<ThreadSummary | undefined> => {
  if (!(await canUseThread(harness, callerId, threadId))) return undefined
  const doc = await harness.snapshot(ThreadDoc, threadId as ConversationId, context)
  return doc === undefined ? undefined : summaryOf(threadId, doc)
}

type ProjectChoice =
  | { readonly projectId: string; readonly project: ProjectState; readonly spaceId: string }
  | { readonly kind: "rejected"; readonly reason: string }

const projectFor = async (
  harness: Harness,
  scope: Extract<Scope, { kind: "puck" | "space" }>,
  requested: string | undefined,
): Promise<ProjectChoice> => {
  if (scope.kind === "space") {
    if (scope.project === undefined)
      return { kind: "rejected", reason: `Space ${scope.spaceId} has no project to run a thread in.` }
    if (scope.space.archived) return { kind: "rejected", reason: `Space ${scope.spaceId} is archived.` }
    if (requested !== undefined && requested !== scope.projectId && requested !== scope.project.slug)
      return {
        kind: "rejected",
        reason: `delegate_task can only start threads in this conversation's own project (${scope.project.slug}).`,
      }
    return { projectId: scope.projectId, project: scope.project, spaceId: scope.spaceId }
  }
  if (requested === undefined)
    return { kind: "rejected", reason: "Puck must name a project (its slug or id) to start a thread." }
  const resolved = await projectByRef(harness, requested)
  if (resolved === undefined) return { kind: "rejected", reason: `No project "${requested}".` }
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  const spaceId = workspace === undefined ? undefined : defaultSpaceOf(workspace, resolved.projectId)
  if (spaceId === undefined || workspace?.spaces[spaceId]?.archived === true)
    return { kind: "rejected", reason: `Project "${requested}" has no live space to run a thread in.` }
  return { projectId: resolved.projectId, project: resolved.project, spaceId }
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

  const delegate = async (caller: Caller, request: DelegateRequest, callContext: Context): Promise<DelegateOutcome> => {
    const harness = deps.harness
    const scope = await scopeOf(harness, caller.conversationId)
    if (scope === undefined || scope.kind === "thread") return { kind: "not_coordinator" }
    const found = await projectFor(harness, scope, request.project)
    if ("kind" in found) return found
    const role: ThreadRole = request.role ?? "thread"
    const model = await resolveModel(
      caller.conversationId,
      role,
      projectOf(found.projectId, found.project),
      request.model,
      callContext,
    )
    if (model.kind === "none") return { kind: "no_model", reason: model.reason }
    const requestId = `delegate:${caller.conversationId}:${request.clientRequestId}`
    const created = await harness.commit(
      (tx: Tx) =>
        threads.createThread(tx, {
          projectId: found.projectId as ProjectId,
          spaceId: found.spaceId,
          parentId: caller.conversationId,
          title: request.title,
          role,
          task: request.task,
          model: model.model,
          clientRequestId: request.clientRequestId,
          requestId,
          removeTools: childTools(deps.registry),
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
    const scope = await scopeOf(deps.harness, caller.conversationId)
    if (scope === undefined) return { kind: "not_in_project" }
    if (scope.kind === "puck") {
      const workspace = await deps.harness.snapshot(WorkspaceDoc, context)
      if (workspace === undefined) return { kind: "all", threads: [] }
      const found: ListedThread[] = []
      for (const space of Object.values(workspace.spaces)) {
        if (space.archived) continue
        const project = workspace.projects[space.projectId]
        if (project === undefined || project.archived) continue
        if (filter.projectId !== undefined && filter.projectId !== space.projectId && filter.projectId !== project.slug)
          continue
        for (const id of space.threadIds) {
          const doc = await deps.harness.snapshot(ThreadDoc, id as ConversationId, context)
          if (doc === undefined || doc.archived === true) continue
          if (filter.status !== undefined && doc.status !== filter.status) continue
          found.push({ ...summaryOf(id, doc), projectId: space.projectId })
        }
      }
      return { kind: "all", threads: found }
    }
    if (
      filter.projectId !== undefined &&
      filter.projectId !== scope.projectId &&
      filter.projectId !== scope.project?.slug
    )
      return { kind: "no_project", projectId: filter.projectId }
    const matching: ThreadSummary[] = []
    for (const id of scope.space.threadIds) {
      const doc = await deps.harness.snapshot(ThreadDoc, id as ConversationId, context)
      if (doc === undefined || doc.archived === true) continue
      if (filter.status !== undefined && doc.status !== filter.status) continue
      matching.push(summaryOf(id, doc))
    }
    return { kind: "threads", projectId: scope.projectId, threads: matching }
  }

  const capabilities = async (caller: Caller, callContext: Context): Promise<CapabilitiesOutcome> => {
    const conversation = await deps.harness.conversation(caller.conversationId, callContext)
    const agent = conversation === undefined ? undefined : await conversation.agent(callContext)
    const listed = (await models().getAvailable()).slice(0, 10).map((model) => `${model.provider}/${model.id}`)
    const scope = await scopeOf(deps.harness, caller.conversationId)
    const workspace = scope?.kind === "puck" ? await deps.harness.snapshot(WorkspaceDoc, context) : undefined
    const projects: PuckProject[] = []
    if (workspace !== undefined) {
      for (const [id, project] of Object.entries(workspace.projects)) {
        if (project.archived) continue
        const threadIds = Object.values(workspace.spaces)
          .filter((space) => space.projectId === id && !space.archived)
          .flatMap((space) => space.threadIds)
        projects.push({
          id,
          slug: project.slug,
          name: project.name,
          live: await liveCount(deps.harness, threadIds),
        })
      }
    }
    const live = scope?.kind === "space" ? await liveCount(deps.harness, scope.space.threadIds) : undefined
    const project =
      scope?.kind === "space" && scope.project !== undefined && live !== undefined
        ? { name: scope.project.name, threadLimit: scope.project.settings.threadLimit, live }
        : undefined
    return {
      ...(agent?.model === undefined ? {} : { model: agent.model }),
      models: listed,
      ...(project === undefined ? {} : { project }),
      ...(workspace === undefined ? {} : { puck: { projects } }),
    }
  }

  const create = async (caller: Caller, request: CreateThreadRequest): Promise<CreateThreadOutcome> => {
    const outcome = await deps.run(
      { id: commandId(`thread.create:${caller.taskId}`), op: "thread.create", args: request },
      { kind: "agent", conversationId: caller.conversationId },
    )
    return outcome.kind === "ok"
      ? { kind: "ok", result: outcome.result }
      : { kind: "rejected", message: outcome.message }
  }

  return {
    delegate,
    create,
    status,
    stop,
    send,
    read,
    list,
    capabilities,
    report: (tx: Tx, input: ReporterInput): Promise<void> => threads.report(tx, input),
  }
}
