import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable"
import { createContributions } from "../../src/contributions.ts"
import type {
  AssignOutcome,
  ConversationPresetView,
  PresetContribution,
  PresetPrompts,
  PresetTools,
  PresetView,
  PresetsService,
} from "../../src/contracts/presets.ts"
import { type ProjectState, WorkspaceDoc, type WorkspaceState } from "../../src/contracts/workspace.ts"
import type { ProjectId } from "../../src/ids.ts"

const context = BACKGROUND_CONTEXT
const TOOL_ROW = "tool-"
const PROMPT_ROW = "prompt-"

export const MIGRATIONS: readonly SqliteMigration[] = [
  { version: 1, statements: ["CREATE TABLE presets (project TEXT PRIMARY KEY, preset TEXT NOT NULL)"] },
  {
    version: 2,
    statements: ["CREATE TABLE conversation_presets (conversation INTEGER PRIMARY KEY, preset TEXT NOT NULL)"],
  },
]

export type PresetDefinition = {
  readonly title: string
  readonly description: string
  readonly tools: PresetTools
  readonly prompts: PresetPrompts
}

export type PresetConfig = {
  readonly default: string
  readonly presets: Readonly<Record<string, PresetDefinition>>
}

export type InstalledExtension = {
  readonly extension: Extension
  readonly row: string | undefined
}

export type PresetsPort = {
  readonly db: SqliteDatabase
  readonly harness: Harness
  extensions(): readonly InstalledExtension[]
  readonly config: PresetConfig
}

export type PresetTarget =
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "conversation"; readonly id: number }

export type PresetsFeature = {
  readonly service: PresetsService
  applyAll(): Promise<void>
  assign(target: PresetTarget, preset: string | null): Promise<AssignOutcome>
  conversations(workspace: WorkspaceState): readonly ConversationPresetView[]
  clear(): Promise<void>
}

const byId = (left: PresetView, right: PresetView): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

const names = (extensions: readonly Extension[]): readonly string[] =>
  extensions.map((extension) => extension.name).toSorted()

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

const projectOfConversation = (workspace: WorkspaceState | undefined, conversationId: number): string | undefined => {
  if (workspace === undefined) return undefined
  for (const [projectId, project] of Object.entries(workspace.projects))
    if (project.coordinatorId === conversationId || project.threadIds.includes(conversationId)) return projectId
  return undefined
}

const removalsOf = (preset: PresetView, installed: readonly InstalledExtension[]): readonly Extension[] => {
  const removed = new Set<string>()
  if (preset.tools !== "all") {
    const allowed = new Set(preset.tools)
    for (const { extension } of installed)
      if (extension.name.startsWith(TOOL_ROW) && !allowed.has(extension.name)) removed.add(extension.name)
  }
  if (preset.prompts !== "all") {
    const allowed = new Set<string>(preset.prompts === "none" ? [] : preset.prompts)
    for (const { extension, row } of installed)
      if (extension.name.startsWith(PROMPT_ROW) && (row === undefined || !allowed.has(row))) removed.add(extension.name)
  }
  return installed.filter(({ extension }) => removed.has(extension.name)).map(({ extension }) => extension)
}

export async function createPresets(port: PresetsPort): Promise<PresetsFeature> {
  const views = new Map<string, PresetView>()
  for (const [id, preset] of Object.entries(port.config.presets))
    views.set(id, {
      id,
      title: preset.title,
      description: preset.description,
      tools: preset.tools,
      prompts: preset.prompts,
    })
  const fallback = views.get(port.config.default)
  if (fallback === undefined) throw new Error(`default preset "${port.config.default}" is not declared in presets`)

  const contributed = createContributions<PresetView>({
    key: (view) => view.id,
    label: (id) => `preset "${id}"`,
  })

  const all = (): ReadonlyMap<string, PresetView> => {
    const merged = new Map<string, PresetView>()
    for (const view of contributed.values()) merged.set(view.id, view)
    for (const [id, view] of views) merged.set(id, view)
    return merged
  }

  const viewOf = (id: string | undefined): PresetView | undefined => (id === undefined ? undefined : all().get(id))

  const projectAssignments = new Map<string, string>()
  for (const row of await port.db.all<{ project: string; preset: string }>("SELECT project, preset FROM presets"))
    projectAssignments.set(row.project, row.preset)

  const conversationAssignments = new Map<number, string>()
  for (const row of await port.db.all<{ conversation: number; preset: string }>(
    "SELECT conversation, preset FROM conversation_presets",
  ))
    conversationAssignments.set(row.conversation, row.preset)

  const projectPreset = (projectId: string): PresetView => viewOf(projectAssignments.get(projectId)) ?? fallback

  const coordinatorPreset = (projectId: string, project: ProjectState): PresetView =>
    viewOf(conversationAssignments.get(project.coordinatorId)) ?? projectPreset(projectId)

  const conversationPreset = (projectId: string, project: ProjectState, conversationId: number): PresetView =>
    viewOf(conversationAssignments.get(conversationId)) ??
    (conversationId === project.coordinatorId ? projectPreset(projectId) : coordinatorPreset(projectId, project))

  const align = async (
    conversationId: number,
    removals: readonly Extension[],
    installed: readonly InstalledExtension[],
  ): Promise<void> => {
    const conversation = await port.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) return
    const removed = new Set(removals.map((extension) => extension.name))
    const remaining = installed.filter(({ extension }) => !removed.has(extension.name))
    const expected = names(remaining.map(({ extension }) => extension))
    const agent = await conversation.agent(context)
    if (sameNames(names(agent.extensions), expected)) return
    await conversation.configure({ extensions: removals.length === 0 ? null : { remove: removals } }, context)
  }

  const applyProject = async (workspace: WorkspaceState, projectId: string): Promise<void> => {
    const project = workspace.projects[projectId]
    if (project === undefined) return
    const installed = port.extensions()
    for (const conversationId of [project.coordinatorId, ...project.threadIds]) {
      const removals = removalsOf(conversationPreset(projectId, project, conversationId), installed)
      await align(conversationId, removals, installed)
    }
  }

  let queue: Promise<void> = Promise.resolve()
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const run = queue.then(work, work)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const applyOne = async (projectId: string): Promise<void> => {
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    if (workspace !== undefined) await applyProject(workspace, projectId)
  }

  const applyAll = (): Promise<void> =>
    enqueue(async () => {
      const workspace = await port.harness.snapshot(WorkspaceDoc, context)
      if (workspace === undefined) return
      for (const projectId of Object.keys(workspace.projects)) await applyProject(workspace, projectId)
    })

  const clear = (): Promise<void> =>
    enqueue(async () => {
      const workspace = await port.harness.snapshot(WorkspaceDoc, context)
      if (workspace === undefined) return
      const installed = port.extensions()
      for (const project of Object.values(workspace.projects))
        for (const conversationId of [project.coordinatorId, ...project.threadIds])
          await align(conversationId, [], installed)
    })

  const contribute = async (preset: PresetContribution, source: string): Promise<() => Promise<void>> => {
    const view: PresetView = {
      id: preset.id ?? source,
      title: preset.title,
      description: preset.description,
      tools: preset.tools,
      prompts: preset.prompts,
    }
    const remove = contributed.add(source, view)
    await applyAll()
    return async () => {
      remove()
      await applyAll()
    }
  }

  const assignProject = async (
    workspace: WorkspaceState,
    projectId: string,
    presetId: string,
  ): Promise<AssignOutcome> => {
    if (workspace.projects[projectId] === undefined) return { kind: "bad_args", reason: `no project ${projectId}` }
    const preset = viewOf(presetId)
    if (preset === undefined) return { kind: "bad_args", reason: `no preset "${presetId}"` }
    await port.db.run(
      "INSERT INTO presets (project, preset) VALUES (?, ?) ON CONFLICT (project) DO UPDATE SET preset = excluded.preset",
      projectId,
      presetId,
    )
    projectAssignments.set(projectId, presetId)
    await enqueue(() => applyOne(projectId))
    return { kind: "assigned", target: { kind: "project", projectId: projectId as ProjectId }, preset }
  }

  const assignConversation = async (
    workspace: WorkspaceState,
    conversationId: number,
    presetId: string | null,
  ): Promise<AssignOutcome> => {
    const projectId = projectOfConversation(workspace, conversationId)
    if (projectId === undefined) return { kind: "bad_args", reason: `no conversation ${conversationId}` }
    const preset = presetId === null ? null : viewOf(presetId)
    if (presetId !== null && preset === undefined) return { kind: "bad_args", reason: `no preset "${presetId}"` }
    if (presetId === null) {
      await port.db.run("DELETE FROM conversation_presets WHERE conversation = ?", conversationId)
      conversationAssignments.delete(conversationId)
    } else {
      await port.db.run(
        "INSERT INTO conversation_presets (conversation, preset) VALUES (?, ?) ON CONFLICT (conversation) DO UPDATE SET preset = excluded.preset",
        conversationId,
        presetId,
      )
      conversationAssignments.set(conversationId, presetId)
    }
    await enqueue(() => applyOne(projectId))
    return {
      kind: "assigned",
      target: { kind: "conversation", conversationId: conversationId as ConversationId },
      preset: preset ?? null,
    }
  }

  const assign = async (target: PresetTarget, presetId: string | null): Promise<AssignOutcome> => {
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    if (workspace === undefined) return { kind: "bad_args", reason: "Home is not ready" }
    if (target.kind === "project")
      return presetId === null
        ? { kind: "bad_args", reason: "a project assignment needs a preset" }
        : assignProject(workspace, target.id, presetId)
    return assignConversation(workspace, target.id, presetId)
  }

  const conversations = (workspace: WorkspaceState): readonly ConversationPresetView[] => {
    const found: ConversationPresetView[] = []
    for (const [projectId, project] of Object.entries(workspace.projects)) {
      for (const conversationId of [project.coordinatorId, ...project.threadIds]) {
        if (!conversationAssignments.has(conversationId)) continue
        found.push({
          conversation: conversationId as ConversationId,
          preset: conversationPreset(projectId, project, conversationId),
        })
      }
    }
    return found.toSorted((left, right) => left.conversation - right.conversation)
  }

  return {
    service: {
      list: () => [...all().values()].toSorted(byId),
      presetOf: (projectId) => projectPreset(projectId),
      contribute,
    },
    applyAll,
    assign,
    conversations,
    clear,
  }
}
