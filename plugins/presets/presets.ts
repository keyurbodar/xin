import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable"
import type { AssignOutcome, PresetTools, PresetView, PresetsService } from "../../src/contracts/presets.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { ProjectId } from "../../src/ids.ts"

const context = BACKGROUND_CONTEXT
const TOOL_ROW = "tool-"

export const MIGRATIONS: readonly SqliteMigration[] = [
  { version: 1, statements: ["CREATE TABLE presets (project TEXT PRIMARY KEY, preset TEXT NOT NULL)"] },
]

export type PresetDefinition = {
  readonly title: string
  readonly description: string
  readonly tools: PresetTools
}

export type PresetConfig = {
  readonly default: string
  readonly presets: Readonly<Record<string, PresetDefinition>>
}

export type PresetsPort = {
  readonly db: SqliteDatabase
  readonly harness: Harness
  extensions(): readonly Extension[]
  readonly config: PresetConfig
}

export type PresetsFeature = {
  readonly service: PresetsService
  applyAll(): Promise<void>
  assign(projectId: string, preset: string): Promise<AssignOutcome>
  clear(): Promise<void>
}

const byId = (left: PresetView, right: PresetView): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

const names = (extensions: readonly Extension[]): readonly string[] =>
  extensions.map((extension) => extension.name).toSorted()

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

export async function createPresets(port: PresetsPort): Promise<PresetsFeature> {
  const views = new Map<string, PresetView>()
  for (const [id, preset] of Object.entries(port.config.presets))
    views.set(id, { id, title: preset.title, description: preset.description, tools: preset.tools })
  const fallback = views.get(port.config.default)
  if (fallback === undefined) throw new Error(`default preset "${port.config.default}" is not declared in presets`)

  const assignments = new Map<string, string>()
  for (const row of await port.db.all<{ project: string; preset: string }>("SELECT project, preset FROM presets"))
    assignments.set(row.project, row.preset)

  const effective = (projectId: string): PresetView => views.get(assignments.get(projectId) ?? "") ?? fallback

  const removalsOf = (tools: PresetTools): readonly Extension[] => {
    if (tools === "all") return []
    const allowed = new Set(tools)
    return port.extensions().filter((extension) => extension.name.startsWith(TOOL_ROW) && !allowed.has(extension.name))
  }

  const align = async (conversationId: number, removals: readonly Extension[]): Promise<void> => {
    const conversation = await port.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) return
    const removed = new Set(removals.map((extension) => extension.name))
    const expected = names(port.extensions().filter((extension) => !removed.has(extension.name)))
    const agent = await conversation.agent(context)
    if (sameNames(names(agent.extensions), expected)) return
    await conversation.configure({ extensions: removals.length === 0 ? null : { remove: removals } }, context)
  }

  const restore = async (conversationId: number): Promise<void> => {
    const conversation = await port.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) return
    const agent = await conversation.agent(context)
    if (sameNames(names(agent.extensions), names(port.extensions()))) return
    await conversation.configure({ extensions: null }, context)
  }

  const applyProject = async (projectId: string): Promise<void> => {
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    const project = workspace?.projects[projectId]
    if (project === undefined) return
    const removals = removalsOf(effective(projectId).tools)
    await align(project.coordinatorId, removals)
    for (const threadId of project.threadIds) await align(threadId, removals)
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

  const applyAll = (): Promise<void> =>
    enqueue(async () => {
      const workspace = await port.harness.snapshot(WorkspaceDoc, context)
      if (workspace === undefined) return
      for (const projectId of Object.keys(workspace.projects)) await applyProject(projectId)
    })

  const clear = (): Promise<void> =>
    enqueue(async () => {
      const workspace = await port.harness.snapshot(WorkspaceDoc, context)
      if (workspace === undefined) return
      for (const project of Object.values(workspace.projects)) {
        await restore(project.coordinatorId)
        for (const threadId of project.threadIds) await restore(threadId)
      }
    })

  const assign = async (projectId: string, presetId: string): Promise<AssignOutcome> => {
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    if (workspace?.projects[projectId] === undefined) return { kind: "bad_args", reason: `no project ${projectId}` }
    const preset = views.get(presetId)
    if (preset === undefined) return { kind: "bad_args", reason: `no preset "${presetId}"` }
    await port.db.run(
      "INSERT INTO presets (project, preset) VALUES (?, ?) ON CONFLICT (project) DO UPDATE SET preset = excluded.preset",
      projectId,
      presetId,
    )
    assignments.set(projectId, presetId)
    await enqueue(() => applyProject(projectId))
    return { kind: "assigned", projectId: projectId as ProjectId, preset }
  }

  return {
    service: { list: () => [...views.values()].toSorted(byId), presetOf: (projectId) => effective(projectId) },
    applyAll,
    assign,
    clear,
  }
}
