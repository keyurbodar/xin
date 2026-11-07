import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable"
import { createContributions } from "../../src/contributions.ts"
import type { ConversationPresetView, PresetView, PresetsService } from "../../src/contracts/presets.ts"
import { WorkspaceDoc, type ProjectState, type WorkspaceState } from "../../src/contracts/workspace.ts"
import { serial } from "../../src/serial.ts"

const context = BACKGROUND_CONTEXT
const TOOL_EXTENSION = "tool-"

export const MIGRATIONS: readonly SqliteMigration[] = [
  { version: 1, statements: ["CREATE TABLE presets (project TEXT PRIMARY KEY, preset TEXT NOT NULL)"] },
  {
    version: 2,
    statements: ["CREATE TABLE conversation_presets (conversation INTEGER PRIMARY KEY, preset TEXT NOT NULL)"],
  },
  {
    version: 3,
    statements: [
      "DROP TABLE IF EXISTS presets",
      "DROP TABLE IF EXISTS conversation_presets",
      "CREATE TABLE presets (conversation INTEGER PRIMARY KEY, preset TEXT NOT NULL)",
    ],
  },
]

export type PresetConfig = {
  readonly default: string
}

export type InstalledExtension = {
  readonly extension: Extension
}

export type PresetsPort = {
  readonly db: SqliteDatabase
  readonly harness: Harness
  extensions(): readonly InstalledExtension[]
  readonly config: PresetConfig
}

export type SelectOutcome =
  | { readonly kind: "selected"; readonly conversation: ConversationId; readonly preset: PresetView }
  | { readonly kind: "bad_args"; readonly reason: string }

export type PresetsFeature = {
  readonly service: PresetsService
  applyAll(): Promise<void>
  select(conversation: number, presetId: string): Promise<SelectOutcome>
  conversations(): Promise<readonly ConversationPresetView[]>
  clear(): Promise<void>
}

type ConversationEntry = {
  readonly project: ProjectState
  readonly conversationId: ConversationId
}

const names = (extensions: readonly Extension[]): readonly string[] =>
  extensions.map((extension) => extension.name).toSorted()

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

const orderOf = (view: PresetView): number => view.order ?? Number.POSITIVE_INFINITY

const entriesOf = (workspace: WorkspaceState): readonly ConversationEntry[] =>
  Object.values(workspace.projects).flatMap((project) => [
    { project, conversationId: project.coordinatorId as ConversationId },
    ...project.threadIds.map((conversationId) => ({ project, conversationId: conversationId as ConversationId })),
  ])

const hasTurns = (messages: readonly { readonly role: string }[]): boolean =>
  messages.some((message) => message.role === "user" || message.role === "assistant")

const removalsOf = (preset: PresetView | undefined, installed: readonly InstalledExtension[]): readonly Extension[] => {
  if (preset === undefined || preset.tools === "all") return []
  const allowed = new Set(preset.tools)
  return installed
    .filter(({ extension }) => extension.name.startsWith(TOOL_EXTENSION) && !allowed.has(extension.name))
    .map(({ extension }) => extension)
}

export async function createPresets(port: PresetsPort): Promise<PresetsFeature> {
  const contributed = createContributions<PresetView>({
    key: (view) => view.id,
    label: (id) => `preset "${id}"`,
  })
  const defaultId = port.config.default

  const records = new Map<number, string>()
  for (const row of await port.db.all<{ conversation: number; preset: string }>(
    "SELECT conversation, preset FROM presets",
  ))
    records.set(row.conversation, row.preset)

  const views = (): ReadonlyMap<string, PresetView> => new Map(contributed.values().map((view) => [view.id, view]))
  const viewOf = (id: string | undefined): PresetView | undefined => (id === undefined ? undefined : views().get(id))
  const resolved = (id: string | undefined): PresetView | undefined => {
    const all = views()
    return (id === undefined ? undefined : all.get(id)) ?? all.get(defaultId)
  }

  const list = (): readonly PresetView[] =>
    contributed.values().toSorted((left, right) => {
      const leftOrder = orderOf(left)
      const rightOrder = orderOf(right)
      if (leftOrder === rightOrder) return left.id.localeCompare(right.id)
      return leftOrder < rightOrder ? -1 : 1
    })

  const align = async (
    conversationId: number,
    preset: PresetView | undefined,
    installed: readonly InstalledExtension[],
  ): Promise<void> => {
    const conversation = await port.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) return
    const removals = removalsOf(preset, installed)
    const removed = new Set(removals.map((extension) => extension.name))
    const expected = names(
      installed.filter(({ extension }) => !removed.has(extension.name)).map(({ extension }) => extension),
    )
    const agent = await conversation.agent(context)
    if (sameNames(names(agent.extensions), expected)) return
    await conversation.configure({ extensions: removals.length === 0 ? null : { remove: removals } }, context)
  }

  const remember = async (conversationId: number, preset: string): Promise<void> => {
    if (records.has(conversationId)) return
    await port.db.run("INSERT OR IGNORE INTO presets (conversation, preset) VALUES (?, ?)", conversationId, preset)
    records.set(conversationId, preset)
  }

  const reconcile = async (): Promise<WorkspaceState | undefined> => {
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    if (workspace === undefined) return undefined
    for (const project of Object.values(workspace.projects)) {
      const coordinator = project.coordinatorId
      await remember(coordinator, project.preset ?? defaultId)
      const inherited = records.get(coordinator) ?? project.preset ?? defaultId
      for (const threadId of project.threadIds) await remember(threadId, inherited)
    }
    return workspace
  }

  const applyRecorded = async (workspace: WorkspaceState): Promise<void> => {
    const installed = port.extensions()
    const all = views()
    const fallback = all.get(defaultId)
    for (const { conversationId } of entriesOf(workspace)) {
      const recorded = records.get(conversationId)
      await align(conversationId, (recorded === undefined ? undefined : all.get(recorded)) ?? fallback, installed)
    }
  }

  const enqueue = serial()

  const applyAll = (): Promise<void> =>
    enqueue(async () => {
      const workspace = await reconcile()
      if (workspace !== undefined) await applyRecorded(workspace)
    })

  const clear = (): Promise<void> =>
    enqueue(async () => {
      const workspace = await port.harness.snapshot(WorkspaceDoc, context)
      const ids = new Set<number>(records.keys())
      if (workspace !== undefined) for (const { conversationId } of entriesOf(workspace)) ids.add(conversationId)
      const installed = port.extensions()
      for (const conversationId of ids) await align(conversationId, undefined, installed)
    })

  const contribute = async (preset: PresetView, source: string): Promise<() => Promise<void>> => {
    if (preset.id.trim().length === 0) throw new Error("a preset id must not be empty")
    const remove = contributed.add(source, preset)
    try {
      await applyAll()
    } catch (error) {
      remove()
      throw error
    }
    return async () => {
      remove()
      await applyAll()
    }
  }

  const select = (conversationId: number, presetId: string): Promise<SelectOutcome> =>
    enqueue(async () => {
      const workspace = await port.harness.snapshot(WorkspaceDoc, context)
      if (workspace === undefined) return { kind: "bad_args", reason: "Home is not ready" } as const
      if (!entriesOf(workspace).some((entry) => entry.conversationId === conversationId))
        return { kind: "bad_args", reason: `no conversation ${conversationId}` } as const
      const preset = viewOf(presetId)
      if (preset === undefined) return { kind: "bad_args", reason: `no preset "${presetId}"` } as const
      const conversation = await port.harness.conversation(conversationId as ConversationId, context)
      if (conversation === undefined)
        return { kind: "bad_args", reason: `conversation ${conversationId} is gone` } as const
      const current = await conversation.context(context)
      if (hasTurns(current.messages))
        return { kind: "bad_args", reason: `conversation ${conversationId} has already started` } as const
      await port.db.run(
        "INSERT INTO presets (conversation, preset) VALUES (?, ?) ON CONFLICT (conversation) DO UPDATE SET preset = excluded.preset",
        conversationId,
        presetId,
      )
      records.set(conversationId, presetId)
      await align(conversationId, preset, port.extensions())
      return { kind: "selected", conversation: conversationId as ConversationId, preset } as const
    })

  const conversations = async (): Promise<readonly ConversationPresetView[]> => {
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    if (workspace === undefined) return []
    return entriesOf(workspace)
      .map(({ conversationId }) => ({
        conversation: conversationId,
        preset: records.get(conversationId) ?? defaultId,
      }))
      .toSorted((left, right) => left.conversation - right.conversation)
  }

  const service: PresetsService = {
    list,
    presetOf: (conversation) => resolved(records.get(conversation)),
    contribute,
  }

  return { service, applyAll, select, conversations, clear }
}
