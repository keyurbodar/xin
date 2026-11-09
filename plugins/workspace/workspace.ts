import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type {
  CommitPublication,
  ConversationId,
  DocumentReader,
  Harness,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import type { CommandId, ProjectId, SpaceId } from "../../src/ids.ts"
import { defineOp, OpRejected, type Op } from "../../src/ops.ts"
import {
  ThreadDoc,
  defaultSpaceOf,
  threadState,
  type ThreadRole,
  type ThreadState,
  type ThreadStatus,
} from "../../src/contracts/threaddoc.ts"
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_THREAD_LIMIT,
  parseWorkspace,
  SettingsPatchSchema,
  SLUG,
  spaceIdOf,
  WorkspaceDoc,
  type ProjectSettings,
  type ProjectState,
  type SettingsPatch,
  type SpaceState,
  type WorkspaceState,
} from "../../src/contracts/workspace.ts"
import { parseRequests, RequestsDoc } from "../../src/contracts/questions.ts"
import { PuckDoc } from "../../src/contracts/puck.ts"

export { ThreadDoc } from "../../src/contracts/threaddoc.ts"
export { RequestsDoc } from "../../src/contracts/questions.ts"
export { DEFAULT_DEADLINE_MS, WorkspaceDoc } from "../../src/contracts/workspace.ts"
export type { ProjectState } from "../../src/contracts/workspace.ts"

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

export type SpaceSummary = {
  readonly id: SpaceId
  readonly name: string
  readonly goal?: string
  readonly projectId: ProjectId
  readonly archived: boolean
  readonly coordinatorId: ConversationId
  readonly threads: ThreadGroups
  readonly openRequests: number
}

export type ProjectSummary = {
  readonly id: ProjectId
  readonly slug: string
  readonly name: string
  readonly archived: boolean
  readonly spaces: SpaceSummary[]
  readonly openRequests: number
  /** The default space, kept on the project projection for existing readers. */
  readonly goal?: string
  readonly coordinatorId?: ConversationId
  readonly threads?: ThreadGroups
  readonly spaceId?: SpaceId
}

type Projection = {
  workspace: WorkspaceState
  threads: Map<ConversationId, ThreadState>
  requests: Map<ConversationId, number>
}

export type OwnerKv = {
  get<T>(key: string): Promise<T | undefined> | undefined
  put(key: string, value: unknown): Promise<void> | void
}

export type OwnerSettings = {
  readonly name: string
  readonly instructions: string
}

export type WorkspacePort = {
  readonly harness: Harness
  readonly kv: OwnerKv
  publishHome(): Promise<void>
}

const OWNER_NAME = "owner.name"
const OWNER_INSTRUCTIONS = "owner.instructions"

export type WorkspaceFeature = {
  readonly ops: readonly Op[]
  start(): Promise<() => void>
  home(): Promise<JsonObject>
  instructions(): Promise<string | undefined>
  spacePrompt(read: DocumentReader, conversationId: ConversationId): Promise<string | undefined>
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

function spaceEntry(id: string, space: SpaceState): JsonObject {
  return {
    id,
    name: space.name,
    ...(space.goal === undefined ? {} : { goal: space.goal }),
    projectId: space.projectId,
    coordinatorId: space.coordinatorId,
    threadIds: [...space.threadIds],
    archived: space.archived,
  }
}

function projectEntry(id: string, project: ProjectState, spaces: readonly [string, SpaceState][]): JsonObject {
  const preferred = spaces.find(([, space]) => !space.archived) ?? spaces[0]
  return {
    id,
    slug: project.slug,
    name: project.name,
    ...(project.preset === undefined ? {} : { preset: project.preset }),
    settings: settingsOf(project.settings),
    archived: project.archived,
    spaces: spaces.map(([spaceId, space]) => spaceEntry(spaceId, space)),
    ...(preferred === undefined
      ? {}
      : {
          spaceId: preferred[0],
          ...(preferred[1].goal === undefined ? {} : { goal: preferred[1].goal }),
          coordinatorId: preferred[1].coordinatorId,
          threadIds: [...preferred[1].threadIds],
        }),
  }
}

const projectIdOf = (commandId: CommandId): ProjectId => `prj_${commandId}` as ProjectId
const spaceIdOfCommand = (commandId: CommandId): SpaceId => `spc_${commandId}` as SpaceId

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

function spacesOf(workspace: WorkspaceState, projectId: string): [string, SpaceState][] {
  return Object.entries(workspace.spaces).filter(([, space]) => space.projectId === projectId)
}

function spaceSummary(projection: Projection, id: string, space: SpaceState): SpaceSummary {
  const threads: ThreadGroups = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }
  const coordinatorId = space.coordinatorId as ConversationId
  let openRequests = projection.requests.get(coordinatorId) ?? 0
  for (const threadId of space.threadIds) {
    const conversationId = threadId as ConversationId
    const thread = projection.threads.get(conversationId)
    if (thread !== undefined && thread.archived !== true)
      threads[thread.status].push(threadSummary(conversationId, thread))
    openRequests += projection.requests.get(conversationId) ?? 0
  }
  return {
    id: id as SpaceId,
    name: space.name,
    ...(space.goal === undefined ? {} : { goal: space.goal }),
    projectId: space.projectId as ProjectId,
    archived: space.archived,
    coordinatorId,
    threads,
    openRequests,
  }
}

function spaceSummaries(projection: Projection, projectId?: string): SpaceSummary[] {
  return Object.entries(projection.workspace.spaces)
    .filter(([, space]) => projectId === undefined || space.projectId === projectId)
    .map(([id, space]) => spaceSummary(projection, id, space))
}

function projectSummaries(projection: Projection): ProjectSummary[] {
  return Object.entries(projection.workspace.projects).map(([id, project]) => {
    const spaces = spacesOf(projection.workspace, id).map(([spaceId, space]) =>
      spaceSummary(projection, spaceId, space),
    )
    const preferred = spaces.find((space) => !space.archived) ?? spaces[0]
    return {
      id: id as ProjectId,
      slug: project.slug,
      name: project.name,
      archived: project.archived,
      spaces,
      openRequests: spaces.reduce((total, space) => total + space.openRequests, 0),
      ...(preferred === undefined
        ? {}
        : {
            ...(preferred.goal === undefined ? {} : { goal: preferred.goal }),
            coordinatorId: preferred.coordinatorId,
            threads: preferred.threads,
            spaceId: preferred.id,
          }),
    }
  })
}

async function ensureDefaultSpace(
  tx: Tx,
  workspace: WorkspaceState,
  projectId: string,
  project: ProjectState,
): Promise<[string, SpaceState]> {
  const found = defaultSpaceOf(workspace, projectId)
  const existing = found === undefined ? undefined : workspace.spaces[found]
  if (found !== undefined && existing !== undefined) return [found, existing]
  const coordinator = await tx.createConversation({ ownership: { kind: "ownerless" } })
  const spaceId = spaceIdOf(projectId)
  const space: SpaceState = {
    name: project.name,
    projectId,
    coordinatorId: coordinator.id,
    threadIds: [],
    archived: project.archived,
  }
  workspace.spaces[spaceId] = space
  return [spaceId, space]
}

async function spacePrompt(read: DocumentReader, conversationId: ConversationId): Promise<string | undefined> {
  const workspace = await read.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT)
  if (workspace === undefined) return undefined
  const thread = await read.snapshot(ThreadDoc, conversationId, BACKGROUND_CONTEXT)
  let space: SpaceState | undefined
  if (thread === undefined) {
    space = Object.values(workspace.spaces).find((entry) => entry.coordinatorId === conversationId)
  } else {
    const spaceId = thread.spaceId ?? defaultSpaceOf(workspace, thread.projectId)
    space = spaceId === undefined ? undefined : workspace.spaces[spaceId]
  }
  if (space === undefined) return undefined
  const project = workspace.projects[space.projectId]
  const lines = [`space: ${space.name}`]
  if (project !== undefined) lines.push(`project: ${project.name} (${project.slug})`)
  if (space.goal !== undefined) lines.push(`goal: ${space.goal}`)
  return lines.join("\n")
}

export function create(port: WorkspacePort): WorkspaceFeature {
  const projection: Projection = {
    workspace: { projects: {}, spaces: {} },
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
      void port.publishHome().catch((failure: unknown) => console.warn("workspace: home publish failed", failure))
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
      preset: opt(str({ minLength: 1, maxLength: 200 })),
    }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      const id = projectIdOf(api.commandId)
      return api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const existing = workspace.projects[id]
        if (existing !== undefined) return projectEntry(id, existing, spacesOf(workspace, id))
        if (Object.values(workspace.projects).some((project) => project.slug === args.slug))
          throw new OpRejected("bad_args", `slug "${args.slug}" is taken`)
        const coordinator = await tx.createConversation({ ownership: { kind: "ownerless" } })
        const project: ProjectState = {
          slug: args.slug,
          name: args.name,
          ...(args.preset === undefined ? {} : { preset: args.preset }),
          settings: defaultSettings(),
          archived: false,
        }
        const spaceId = spaceIdOf(id)
        const space: SpaceState = {
          name: args.name,
          ...(args.goal === undefined ? {} : { goal: args.goal }),
          projectId: id,
          coordinatorId: coordinator.id,
          threadIds: [],
          archived: false,
        }
        workspace.projects[id] = project
        workspace.spaces[spaceId] = space
        return projectEntry(id, project, [[spaceId, space]])
      }, BACKGROUND_CONTEXT)
    },
  })

  const updateProject = defineOp({
    name: "project.update",
    args: obj({
      id: str({ minLength: 1 }),
      name: opt(str({ minLength: 1, maxLength: 200 })),
      goal: opt(str({ maxLength: 4_000 })),
      preset: opt(str({ minLength: 1, maxLength: 200 })),
      settings: opt(SettingsPatchSchema),
    }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const project = workspace.projects[args.id]
        if (project === undefined) throw new OpRejected("bad_args", `no project ${args.id}`)
        const previousName = project.name
        if (args.name !== undefined) project.name = args.name
        if (args.preset !== undefined) project.preset = args.preset
        if (args.settings !== undefined) project.settings = mergeSettings(project.settings, args.settings)
        const spaceId = defaultSpaceOf(workspace, args.id)
        const space = spaceId === undefined ? undefined : workspace.spaces[spaceId]
        if (space !== undefined) {
          if (space.name === previousName && args.name !== undefined) space.name = args.name
          if (args.goal !== undefined) space.goal = args.goal
        } else {
          const [createdId, created] = await ensureDefaultSpace(tx, workspace, args.id, project)
          if (args.goal !== undefined) created.goal = args.goal
          return projectEntry(args.id, project, [[createdId, created]])
        }
        return projectEntry(args.id, project, spacesOf(workspace, args.id))
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
        for (const space of Object.values(workspace.spaces)) {
          if (space.projectId === args.id) space.archived = true
        }
        return projectEntry(args.id, project, spacesOf(workspace, args.id))
      }, BACKGROUND_CONTEXT),
  })

  const createSpace = defineOp({
    name: "space.create",
    args: obj({
      projectId: str({ minLength: 1 }),
      name: str({ minLength: 1, maxLength: 200 }),
      goal: opt(str({ maxLength: 4_000 })),
    }),
    actors: ["owner"],
    run: async (api, args) => {
      const id = spaceIdOfCommand(api.commandId)
      return api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const existing = workspace.spaces[id]
        if (existing !== undefined) return spaceEntry(id, existing)
        const project = workspace.projects[args.projectId]
        if (project === undefined) throw new OpRejected("bad_args", `no project ${args.projectId}`)
        if (project.archived) throw new OpRejected("bad_args", `project ${args.projectId} is archived`)
        const coordinator = await tx.createConversation({ ownership: { kind: "ownerless" } })
        const space: SpaceState = {
          name: args.name,
          ...(args.goal === undefined ? {} : { goal: args.goal }),
          projectId: args.projectId,
          coordinatorId: coordinator.id,
          threadIds: [],
          archived: false,
        }
        workspace.spaces[id] = space
        return spaceEntry(id, space)
      }, BACKGROUND_CONTEXT)
    },
  })

  const updateSpace = defineOp({
    name: "space.update",
    args: obj({
      id: str({ minLength: 1 }),
      name: opt(str({ minLength: 1, maxLength: 200 })),
      goal: opt(str({ maxLength: 4_000 })),
      projectId: opt(str({ minLength: 1 })),
    }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const space = workspace.spaces[args.id]
        if (space === undefined) throw new OpRejected("bad_args", `no space ${args.id}`)
        if (args.projectId !== undefined) {
          if (workspace.projects[args.projectId] === undefined)
            throw new OpRejected("bad_args", `no project ${args.projectId}`)
          space.projectId = args.projectId
        }
        if (args.name !== undefined) space.name = args.name
        if (args.goal !== undefined) space.goal = args.goal
        return spaceEntry(args.id, space)
      }, BACKGROUND_CONTEXT),
  })

  const archiveSpace = defineOp({
    name: "space.archive",
    args: obj({ id: str({ minLength: 1 }) }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceDoc)
        const space = workspace.spaces[args.id]
        if (space === undefined) throw new OpRejected("bad_args", `no space ${args.id}`)
        space.archived = true
        return spaceEntry(args.id, space)
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
        const listed = Object.values(workspace.spaces).some((space) => space.threadIds.includes(args.threadId))
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
    run: async () => ({ projects: projectSummaries(projection), spaces: spaceSummaries(projection) }),
  })

  const puckList = defineOp({
    name: "puck.list",
    args: obj({}),
    actors: ["owner"],
    run: async (api) => {
      const root = await api.harness.root(BACKGROUND_CONTEXT)
      const doc = await api.harness.snapshot(PuckDoc, BACKGROUND_CONTEXT)
      const entries = Object.entries(doc?.conversations ?? {})
        .map(([id, conversation]) => ({
          id,
          title: conversation.title,
          archived: conversation.archived,
          createdAt: conversation.createdAt,
          root: false,
        }))
        .toSorted((left, right) => right.createdAt - left.createdAt)
      return [{ id: String(root.id), title: "Puck", archived: false, createdAt: 0, root: true }, ...entries]
    },
  })

  const puckCreate = defineOp({
    name: "puck.create",
    args: obj({ title: opt(str({ minLength: 1, maxLength: 200 })) }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const doc = await tx.doc(PuckDoc)
        const existing = Object.entries(doc.conversations).find(
          ([, conversation]) => conversation.commandId === api.commandId,
        )
        if (existing !== undefined) return { id: existing[0], ...existing[1] }
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } })
        const value = {
          title: args.title ?? "New conversation",
          archived: false,
          createdAt: Date.now(),
          commandId: api.commandId,
        }
        doc.conversations[String(conversation.id)] = value
        return { id: String(conversation.id), ...value }
      }, BACKGROUND_CONTEXT),
  })

  const puckRename = defineOp({
    name: "puck.rename",
    args: obj({ id: str({ minLength: 1 }), title: str({ minLength: 1, maxLength: 200 }) }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const doc = await tx.doc(PuckDoc)
        const conversation = doc.conversations[args.id]
        if (conversation === undefined) throw new OpRejected("bad_args", `no Puck conversation ${args.id}`)
        conversation.title = args.title
        return { id: args.id, ...conversation }
      }, BACKGROUND_CONTEXT),
  })

  const puckArchive = defineOp({
    name: "puck.archive",
    args: obj({ id: str({ minLength: 1 }) }),
    actors: ["owner"],
    run: async (api, args) =>
      api.harness.commit(async (tx) => {
        const doc = await tx.doc(PuckDoc)
        const conversation = doc.conversations[args.id]
        if (conversation === undefined) throw new OpRejected("bad_args", `no Puck conversation ${args.id}`)
        conversation.archived = true
        return { id: args.id, ...conversation }
      }, BACKGROUND_CONTEXT),
  })

  const owner = async (): Promise<OwnerSettings> => ({
    name: (await port.kv.get<string>(OWNER_NAME)) ?? "",
    instructions: (await port.kv.get<string>(OWNER_INSTRUCTIONS)) ?? "",
  })
  const readOwner = defineOp({
    name: "owner.read",
    args: obj({}),
    actors: ["owner"],
    run: async () => owner(),
  })

  const setOwner = defineOp({
    name: "owner.set",
    args: obj({ name: opt(str({ maxLength: 120 })), instructions: opt(str({ maxLength: 4_000 })) }),
    actors: ["owner"],
    run: async (_api, args) => {
      if (args.name !== undefined) await port.kv.put(OWNER_NAME, args.name.trim())
      if (args.instructions !== undefined) await port.kv.put(OWNER_INSTRUCTIONS, args.instructions.trim())
      return owner()
    },
  })

  return {
    ops: [
      createProject,
      updateProject,
      archiveProject,
      createSpace,
      updateSpace,
      archiveSpace,
      renameThread,
      readWorkspace,
      puckList,
      puckCreate,
      puckRename,
      puckArchive,
      readOwner,
      setOwner,
    ],
    instructions: async () => {
      const text = (await port.kv.get<string>(OWNER_INSTRUCTIONS)) ?? ""
      return text.trim() === "" ? undefined : text
    },
    spacePrompt,
    async start() {
      const harness = port.harness
      const observation = harness.observeCommits({ advance: apply, end: () => undefined })
      const stored = await harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT)
      if (stored !== undefined && parseWorkspace.check(stored)) projection.workspace = stored
      for (const space of Object.values(projection.workspace.spaces)) {
        for (const threadId of space.threadIds) {
          const conversationId = threadId as ConversationId
          const thread = await harness.snapshot(ThreadDoc, conversationId, BACKGROUND_CONTEXT)
          if (thread !== undefined) applyThread(thread, conversationId)
          const requests = await harness.snapshot(RequestsDoc, conversationId, BACKGROUND_CONTEXT)
          if (requests !== undefined) applyRequests(requests, conversationId)
        }
        const coordinatorId = space.coordinatorId as ConversationId
        const requests = await harness.snapshot(RequestsDoc, coordinatorId, BACKGROUND_CONTEXT)
        if (requests !== undefined) applyRequests(requests, coordinatorId)
      }
      return () => observation.detach()
    },
    home: async () => ({ projects: projectSummaries(projection) }),
  }
}
