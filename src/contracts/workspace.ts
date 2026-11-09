import { defineDoc } from "@earendil-works/pi-durable"
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
export const ProjectSchema = obj({
  slug: str({ pattern: SLUG }),
  name: str({ minLength: 1, maxLength: 200 }),
  goal: opt(str({ maxLength: 4_000 })),
  preset: opt(str({ minLength: 1, maxLength: 200 })),
  coordinatorId: int({ minimum: 0 }),
  threadIds: arr(int({ minimum: 0 })),
  settings: SettingsSchema,
  archived: bool(),
})
export const WorkspaceSchema = obj({ projects: map(ProjectSchema) })

export type GitSettings = Static<typeof GitSettingsSchema>
export type ProjectSettings = Static<typeof SettingsSchema>
export type SettingsPatch = Static<typeof SettingsPatchSchema>
export type ProjectState = Static<typeof ProjectSchema>
export type WorkspaceState = Static<typeof WorkspaceSchema>

export const parseWorkspace = compile(WorkspaceSchema)

export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: "xin.workspace",
  version: 1,
  scope: "session",
  initial: () => ({ projects: {} }),
  checkpointWhen: () => false,
})
