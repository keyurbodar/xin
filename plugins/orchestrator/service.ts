import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import type {
  ConversationId,
  DocumentReader,
  EntryId,
  ModelRef,
  ToolExecutionApi,
  Tx,
} from "@earendil-works/pi-durable"
import type {
  CallerProject,
  CreateOutcome,
  CreateThreadArgs,
  EnabledPlugin,
  ProjectThreads,
  ResolvedThreadModel,
  SendMode,
  ThreadEntry,
  ThreadRole,
  ThreadsService,
  ThreadSummary,
} from "../../src/contracts/threads.ts"
import type { CommandId } from "../../src/ids.ts"
import type { ModuleDeps } from "../../src/module.ts"
import type { Outcome } from "../../src/ops.ts"
import { entryText, textOf } from "../../src/transcript.ts"
import { cancelJob } from "../jobs/jobs.ts"
import { ownerDefaults, resolveModel as resolveRoleModel } from "../models/models.ts"
import { projectInScope, ThreadDoc, threadInScope, type ThreadDocState } from "../workspace/threaddoc.ts"
import { WorkspaceDoc, type ProjectState } from "../workspace/workspace.ts"
import type { Threads } from "./threads.ts"

const context = BACKGROUND_CONTEXT

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

export function threadService(deps: ModuleDeps, threads: Threads): ThreadsService {
  const readThread = async (
    threadId: number,
    after: number | undefined,
    callContext: Context,
  ): Promise<readonly ThreadEntry[]> => {
    const conversation = await deps.harness().conversation(threadId as ConversationId, callContext)
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

  const resolveModel = async (
    api: ToolExecutionApi,
    role: ThreadRole,
    project: CallerProject,
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
    const workspace = await api.snapshot(WorkspaceDoc, context)
    const defaults = workspace?.projects[project.projectId]?.settings.models
    const resolved = resolveRoleModel({
      role,
      ...(defaults === undefined ? {} : { project: defaults }),
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

  return {
    coordinator,
    threadsOf,
    threadOf,
    readThread,
    answerText,
    lastText,
    resolveModel,
    createThread: (tx: Tx, args: CreateThreadArgs): Promise<CreateOutcome> => threads.createThread(tx, args),
    enabledPlugins: () => deps.db.all<EnabledPlugin>("SELECT id, state FROM plugins WHERE enabled = 1 ORDER BY id"),
    cancelJob: (conversationId, jobId) => cancelJob(deps, conversationId, jobId),
    stopThread: (conversationId, threadId, reason, commandId) =>
      deps.run(
        {
          id: commandId,
          op: "thread.stop",
          args: { threadId, ...(reason === undefined ? {} : { reason }) },
        },
        { kind: "agent", conversationId },
      ),
    sendToThread: (
      conversationId: ConversationId,
      threadId: number,
      text: string,
      mode: SendMode,
      commandId: CommandId,
    ): Promise<Outcome> =>
      deps.run({ id: commandId, op: "thread.send", args: { threadId, text, mode } }, { kind: "agent", conversationId }),
  }
}
