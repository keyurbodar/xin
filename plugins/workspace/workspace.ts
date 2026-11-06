import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineDoc } from "@earendil-works/pi-durable"
import type { CommitPublication, ConversationId, JsonObject } from "@earendil-works/pi-durable"
import { arr, bool, compile, int, map, num, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import type { CommandId, ProjectId } from "../../src/ids.ts"
import { ModelRefSchema } from "../models/models.ts"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { defineOp, OpRejected } from "../../src/ops.ts"
import { ThreadDoc, threadState, type ThreadRole, type ThreadState, type ThreadStatus } from "./threaddoc.ts"

export { ThreadDoc } from "./threaddoc.ts"

const SLUG = "^[a-z0-9]+(?:-[a-z0-9]+)*$"

export const DEFAULT_DEADLINE_MS = 30 * 60_000
export const DEFAULT_THREAD_LIMIT = 8

const RoleModelsSchema = obj({
  chat: opt(ModelRefSchema),
  thread: opt(ModelRefSchema),
  utility: opt(ModelRefSchema),
})
const SettingsSchema = obj({
  threadLimit: int({ minimum: 1 }),
  deadlineMs: int({ minimum: 1_000 }),
  models: opt(RoleModelsSchema),
})
const SettingsPatchSchema = obj({
  threadLimit: opt(int({ minimum: 1 })),
  deadlineMs: opt(int({ minimum: 1_000 })),
  models: opt(RoleModelsSchema),
})
const ProjectSchema = obj({
  slug: str({ pattern: SLUG }),
  name: str({ minLength: 1, maxLength: 200 }),
  goal: opt(str({ maxLength: 4_000 })),
  coordinatorId: int({ minimum: 0 }),
  threadIds: arr(int({ minimum: 0 })),
  settings: SettingsSchema,
  archived: bool(),
})
const WorkspaceSchema = obj({ projects: map(ProjectSchema) })

const RequestSchema = obj({
  kind: str({ minLength: 1 }),
  question: str(),
  options: opt(arr(str())),
  at: num(),
})
const AnsweredSchema = obj({
  kind: str({ minLength: 1 }),
  question: str(),
  options: opt(arr(str())),
  at: num(),
  answer: str(),
  answeredAt: num(),
})
const RequestsSchema = obj({ open: map(RequestSchema), answered: map(AnsweredSchema) })

export type ProjectSettings = Static<typeof SettingsSchema>
export type SettingsPatch = Static<typeof SettingsPatchSchema>
export type ProjectState = Static<typeof ProjectSchema>
export type WorkspaceState = Static<typeof WorkspaceSchema>
export type OpenRequest = Static<typeof RequestSchema>
export type AnsweredRequest = Static<typeof AnsweredSchema>
export type RequestsState = Static<typeof RequestsSchema>

const parseWorkspace = compile(WorkspaceSchema)
const parseRequests = compile(RequestsSchema)

export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: "xin.workspace",
  version: 1,
  scope: "session",
  initial: () => ({ projects: {} }),
  checkpointWhen: () => false,
})

export const RequestsDoc = defineDoc<RequestsState>({
  kind: "xin.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ open: {}, answered: {} }),
  checkpointWhen: () => false,
})

export type ThreadSummary = {
  readonly id: ConversationId
  readonly title: string
  readonly role: ThreadRole
  readonly status: ThreadStatus
  readonly statusLine?: string
  readonly result?: string
  readonly beatAt?: number
  readonly deadlineAt?: number
}

export type ThreadGroups = Record<ThreadStatus, ThreadSummary[]>

export type ProjectSummary = {
  readonly id: ProjectId
  readonly slug: string
  readonly name: string
  readonly goal?: string
  readonly archived: boolean
  readonly coordinatorId: ConversationId
  readonly threads: ThreadGroups
  readonly openRequests: number
}

type Projection = {
  workspace: WorkspaceState
  threads: Map<ConversationId, ThreadState>
  requests: Map<ConversationId, number>
}

const defaultSettings = (): ProjectSettings => ({
  threadLimit: DEFAULT_THREAD_LIMIT,
  deadlineMs: DEFAULT_DEADLINE_MS,
})

function mergeSettings(current: ProjectSettings, patch: SettingsPatch): ProjectSettings {
  return {
    threadLimit: patch.threadLimit ?? current.threadLimit,
    deadlineMs: patch.deadlineMs ?? current.deadlineMs,
    ...(patch.models === undefined && current.models === undefined
      ? {}
      : { models: { ...current.models, ...patch.models } }),
  }
}

function modelsOf(models: NonNullable<ProjectSettings["models"]>): JsonObject {
  return {
    ...(models.chat === undefined ? {} : { chat: { provider: models.chat.provider, modelId: models.chat.modelId } }),
    ...(models.thread === undefined
      ? {}
      : { thread: { provider: models.thread.provider, modelId: models.thread.modelId } }),
    ...(models.utility === undefined
      ? {}
      : { utility: { provider: models.utility.provider, modelId: models.utility.modelId } }),
  }
}

function settingsOf(settings: ProjectSettings): JsonObject {
  return {
    threadLimit: settings.threadLimit,
    deadlineMs: settings.deadlineMs,
    ...(settings.models === undefined ? {} : { models: modelsOf(settings.models) }),
  }
}

function projectEntry(id: string, project: ProjectState): JsonObject {
  return {
    id,
    slug: project.slug,
    name: project.name,
    ...(project.goal === undefined ? {} : { goal: project.goal }),
    coordinatorId: project.coordinatorId,
    threadIds: [...project.threadIds],
    settings: settingsOf(project.settings),
    archived: project.archived,
  }
}

const projectIdOf = (commandId: CommandId): ProjectId => `prj_${commandId}` as ProjectId

function threadSummary(id: ConversationId, thread: ThreadState): ThreadSummary {
  return {
    id,
    title: thread.title,
    role: thread.role,
    status: thread.status,
    ...(thread.statusLine === undefined ? {} : { statusLine: thread.statusLine }),
    ...(thread.result === undefined ? {} : { result: thread.result }),
    ...(thread.beatAt === undefined ? {} : { beatAt: thread.beatAt }),
    ...(thread.deadlineAt === undefined ? {} : { deadlineAt: thread.deadlineAt }),
  }
}

function projectSummaries(projection: Projection): ProjectSummary[] {
  return Object.entries(projection.workspace.projects).map(([id, project]) => {
    const threads: ThreadGroups = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }
    const coordinatorId = project.coordinatorId as ConversationId
    let openRequests = projection.requests.get(coordinatorId) ?? 0
    for (const threadId of project.threadIds) {
      const conversationId = threadId as ConversationId
      const thread = projection.threads.get(conversationId)
      if (thread !== undefined) threads[thread.status].push(threadSummary(conversationId, thread))
      openRequests += projection.requests.get(conversationId) ?? 0
    }
    return {
      id: id as ProjectId,
      slug: project.slug,
      name: project.name,
      ...(project.goal === undefined ? {} : { goal: project.goal }),
      archived: project.archived,
      coordinatorId,
      threads,
      openRequests,
    }
  })
}

export function create(deps: ModuleDeps): HostModule {
  const projection: Projection = {
    workspace: { projects: {} },
    threads: new Map(),
    requests: new Map(),
  }
  let dirty = false
  let scheduled = false

  const publish = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!dirty) return
      dirty = false
      void deps.publishHome().catch((failure: unknown) => console.warn("workspace: home publish failed", failure))
    })
  }

  const applyThread = (value: unknown, conversationId: ConversationId): void => {
    const state = threadState(value)
    if (state !== undefined) projection.threads.set(conversationId, state)
  }

  const applyRequests = (value: unknown, conversationId: ConversationId): void => {
    if (!parseRequests.check(value)) return
    projection.requests.set(conversationId, Object.keys(value.open).length)
  }

  const apply = (publication: CommitPublication): void => {
    for (const change of publication.changes) {
      if (change.type !== "document" || change.kind !== "change") continue
      switch (change.record.kind) {
        case "xin.workspace": {
          if (parseWorkspace.check(change.value)) projection.workspace = change.value
          dirty = true
          break
        }
        case "xin.thread": {
          if (change.conversationId !== undefined) applyThread(change.value, change.conversationId)
          dirty = true
          break
        }
        case "xin.requests": {
          if (change.conversationId !== undefined) applyRequests(change.value, change.conversationId)
          dirty = true
          break
        }
        default:
          break
      }
    }
    if (dirty) publish()
  }

  const createProject = defineOp({
    name: "project.create",
    args: obj({
      slug: str({ pattern: SLUG, maxLength: 64 }),
      name: str({ minLength: 1, maxLength: 200 }),
      goal: opt(str({ maxLength: 4_000 })),
    }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      const id = projectIdOf(api.commandId)
      return api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const existing = workspace.projects[id]
        if (existing !== undefined) return projectEntry(id, existing)
        if (Object.values(workspace.projects).some((project) => project.slug === args.slug))
          throw new OpRejected("bad_args", `slug "${args.slug}" is taken`)
        const coordinator = await tx.createConversation({ ownership: { kind: "ownerless" } })
        const project: ProjectState = {
          slug: args.slug,
          name: args.name,
          ...(args.goal === undefined ? {} : { goal: args.goal }),
          coordinatorId: coordinator.id,
          threadIds: [],
          settings: defaultSettings(),
          archived: false,
        }
        workspace.projects[id] = project
        return projectEntry(id, project)
      }, BACKGROUND_CONTEXT)
    },
  })

  const updateProject = defineOp({
    name: "project.update",
    args: obj({
      id: str({ minLength: 1 }),
      name: opt(str({ minLength: 1, maxLength: 200 })),
      goal: opt(str({ maxLength: 4_000 })),
      settings: opt(SettingsPatchSchema),
    }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const project = workspace.projects[args.id]
        if (project === undefined) throw new OpRejected("bad_args", `no project ${args.id}`)
        if (args.name !== undefined) project.name = args.name
        if (args.goal !== undefined) project.goal = args.goal
        if (args.settings !== undefined) project.settings = mergeSettings(project.settings, args.settings)
        return projectEntry(args.id, project)
      }, BACKGROUND_CONTEXT),
  })

  const archiveProject = defineOp({
    name: "project.archive",
    args: obj({ id: str({ minLength: 1 }) }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const project = workspace.projects[args.id]
        if (project === undefined) throw new OpRejected("bad_args", `no project ${args.id}`)
        project.archived = true
        return projectEntry(args.id, project)
      }, BACKGROUND_CONTEXT),
  })

  const renameThread = defineOp({
    name: "thread.rename",
    args: obj({ threadId: int({ minimum: 0 }), title: str({ minLength: 1, maxLength: 200 }) }),
    actors: ["owner"],
    run: async (api, args) => {
      const threadId = args.threadId as ConversationId
      return api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const listed = Object.values(workspace.projects).some((project) => project.threadIds.includes(args.threadId))
        if (!listed) throw new OpRejected("bad_args", `no thread ${args.threadId}`)
        if ((await tx.conversation(threadId)) === undefined)
          throw new OpRejected("bad_args", `conversation ${args.threadId} is gone`)
        const thread = await tx.doc(ThreadDoc, threadId)
        thread.title = args.title
        return { threadId: args.threadId, title: args.title }
      }, BACKGROUND_CONTEXT)
    },
  })

  const readWorkspace = defineOp({
    name: "workspace.read",
    args: obj({}),
    actors: ["owner"],
    run: async () => ({ projects: projectSummaries(projection) }),
  })

  return {
    ops: [createProject, updateProject, archiveProject, renameThread, readWorkspace],
    async start() {
      const harness = deps.harness()
      const observation = harness.observeCommits({ advance: apply, end: () => undefined })
      const stored = await harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT)
      if (stored !== undefined && parseWorkspace.check(stored)) projection.workspace = stored
      for (const project of Object.values(projection.workspace.projects)) {
        for (const threadId of project.threadIds) {
          const conversationId = threadId as ConversationId
          const thread = await harness.snapshot(ThreadDoc, conversationId, BACKGROUND_CONTEXT)
          if (thread !== undefined) applyThread(thread, conversationId)
          const requests = await harness.snapshot(RequestsDoc, conversationId, BACKGROUND_CONTEXT)
          if (requests !== undefined) applyRequests(requests, conversationId)
        }
        const coordinatorId = project.coordinatorId as ConversationId
        const requests = await harness.snapshot(RequestsDoc, coordinatorId, BACKGROUND_CONTEXT)
        if (requests !== undefined) applyRequests(requests, coordinatorId)
      }
      return () => observation.detach()
    },
    home: async () => ({ projects: projectSummaries(projection) }),
  }
}
