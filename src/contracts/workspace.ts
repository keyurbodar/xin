import { defineDoc, type JsonObject } from "@earendil-works/pi-durable"
import { arr, bool, compile, int, map, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import { ModelRefSchema } from "./models.ts"

export const SLUG = "^[a-z0-9]+(?:-[a-z0-9]+)*$"

export const DEFAULT_DEADLINE_MS = 30 * 60_000
export const DEFAULT_THREAD_LIMIT = 8

export const RoleModelsSchema = obj({
  chat: opt(ModelRefSchema),
  thread: opt(ModelRefSchema),
  utility: opt(ModelRefSchema),
})
export const GitSettingsSchema = obj({
  repo: str({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
  ref: opt(str({ minLength: 1, maxLength: 200 })),
})
export const SettingsSchema = obj({
  threadLimit: int({ minimum: 1 }),
  deadlineMs: int({ minimum: 1_000 }),
  models: opt(RoleModelsSchema),
  git: opt(GitSettingsSchema),
})
export const SettingsPatchSchema = obj({
  threadLimit: opt(int({ minimum: 1 })),
  deadlineMs: opt(int({ minimum: 1_000 })),
  models: opt(RoleModelsSchema),
  git: opt(GitSettingsSchema),
})

/** A project is the environment: settings, files and memory. It has no conversation. */
export const ProjectSchema = obj({
  slug: str({ pattern: SLUG }),
  name: str({ minLength: 1, maxLength: 200 }),
  preset: opt(str({ minLength: 1, maxLength: 200 })),
  settings: SettingsSchema,
  archived: bool(),
})

/** A space is a directed chat in a project: one coordinator conversation, a goal and its threads. */
export const SpaceSchema = obj({
  name: str({ minLength: 1, maxLength: 200 }),
  goal: opt(str({ maxLength: 4_000 })),
  projectId: str({ minLength: 1 }),
  coordinatorId: int({ minimum: 0 }),
  threadIds: arr(int({ minimum: 0 })),
  archived: bool(),
})

export const WorkspaceSchema = obj({
  projects: map(ProjectSchema),
  spaces: map(SpaceSchema),
})

export type ProjectSettings = Static<typeof SettingsSchema>
export type SettingsPatch = Static<typeof SettingsPatchSchema>
export type ProjectState = Static<typeof ProjectSchema>
export type SpaceState = Static<typeof SpaceSchema>
export type WorkspaceState = Static<typeof WorkspaceSchema>

export const parseWorkspace = compile(WorkspaceSchema)

export function threadIdsOfProject(workspace: WorkspaceState | undefined, projectId: string): readonly number[] {
  if (workspace === undefined) return []
  return Object.values(workspace.spaces)
    .filter((space) => space.projectId === projectId)
    .flatMap((space) => space.threadIds)
}

const LegacyProjectSchema = obj({
  slug: str({ pattern: SLUG }),
  name: str({ minLength: 1, maxLength: 200 }),
  goal: opt(str({ maxLength: 4_000 })),
  preset: opt(str({ minLength: 1, maxLength: 200 })),
  coordinatorId: int({ minimum: 0 }),
  threadIds: arr(int({ minimum: 0 })),
  settings: SettingsSchema,
  archived: bool(),
})

const LegacyWorkspaceSchema = obj({ projects: map(LegacyProjectSchema) })
const parseLegacy = compile(LegacyWorkspaceSchema)

export type GitSettings = Static<typeof GitSettingsSchema>

export const spaceIdOf = (projectId: string): string =>
  projectId.startsWith("prj_") ? `spc_${projectId.slice(4)}` : `spc_${projectId}`

/** Version 1 stored the Space on the Project. Every old project becomes one Project plus one Space. */
function migrateWorkspace(value: JsonObject): WorkspaceState {
  if (!parseLegacy.check(value)) throw new Error("xin.workspace v1 does not match the legacy shape")
  const projects: Record<string, ProjectState> = {}
  const spaces: Record<string, SpaceState> = {}
  for (const [id, legacy] of Object.entries(value.projects)) {
    projects[id] = {
      slug: legacy.slug,
      name: legacy.name,
      ...(legacy.preset === undefined ? {} : { preset: legacy.preset }),
      settings: legacy.settings,
      archived: legacy.archived,
    }
    spaces[spaceIdOf(id)] = {
      name: legacy.name,
      ...(legacy.goal === undefined ? {} : { goal: legacy.goal }),
      projectId: id,
      coordinatorId: legacy.coordinatorId,
      threadIds: [...legacy.threadIds],
      archived: legacy.archived,
    }
  }
  return { projects, spaces }
}

export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: "xin.workspace",
  version: 2,
  scope: "session",
  initial: () => ({ projects: {}, spaces: {} }),
  migrate: (value, fromVersion) => {
    if (fromVersion < 2) return migrateWorkspace(value)
    if (!parseWorkspace.check(value)) throw new Error("xin.workspace v2 does not match the current shape")
    return value
  },
  checkpointWhen: () => false,
})
