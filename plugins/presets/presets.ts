import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { createContributions } from "../../src/contributions.ts"
import type { ConversationPresetView, PresetView, PresetsService } from "../../src/contracts/presets.ts"
import { WorkspaceDoc, type WorkspaceState } from "../../src/contracts/workspace.ts"
import { serial } from "../../src/serial.ts"

const context = BACKGROUND_CONTEXT

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

/** One installed pi extension and the plugin row that installed it. */
export type InstalledExtension = {
  readonly extension: Extension
  readonly plugin: string | undefined
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
  forget(conversation: number): Promise<void>
  conversations(): Promise<readonly ConversationPresetView[]>
  clear(): Promise<void>
}

type ConversationEntry = {
  readonly conversationId: ConversationId
}

const names = (extensions: readonly Extension[]): readonly string[] =>
  extensions.map((extension) => extension.name).toSorted()

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

const orderOf = (view: PresetView): number => view.order ?? Number.POSITIVE_INFINITY

const entriesOf = (workspace: WorkspaceState): readonly ConversationEntry[] =>
  Object.values(workspace.projects).flatMap((project) => [
    { conversationId: project.coordinatorId as ConversationId },
    ...project.threadIds.map((conversationId) => ({ conversationId: conversationId as ConversationId })),
  ])

const hasTurns = (messages: readonly { readonly role: string }[]): boolean =>
  messages.some((message) => message.role === "user" || message.role === "assistant")

/** The extensions a preset removes: every installed extension whose plugin the preset does not name. */
const removalsOf = (
  preset: PresetView | undefined,
  installed: readonly InstalledExtension[],
): readonly Extension[] => {
  if (preset === undefined || preset.plugins === "all") return []
  const allowed = new Set(preset.plugins)
  return installed
    .filter(({ plugin }) => plugin !== undefined && !allowed.has(plugin))
    .map(({ extension }) => extension)
}

export async function createPresets(port: PresetsPort): Promise<PresetsFeature> {
  const contributed = createContributions<PresetView>({
    key: (view) => view.id,
    label: (id) => `preset "${id}"`,
  })
  const defaultId = port.config.default
  const enqueue = serial()

  const records = new Map<number, string>()
  for (const row of await port.db.all<{ conversation: number; preset: string }>(
    "SELECT conversation, preset FROM presets",
  ))
    records.set(row.conversation, row.preset)

  const projectOf = new Map<number, number>()
  const projectPreset = new Map<number, string | undefined>()

  const views = (): ReadonlyMap<string, PresetView> => new Map(contributed.values().map((view) => [view.id, view]))
  const viewOf = (id: string | undefined): PresetView | undefined => (id === undefined ? undefined : views().get(id))
  const resolvedId = (conversation: number): string => {
    const recorded = records.get(conversation)
    if (recorded !== undefined) return recorded
    const coordinator = projectOf.get(conversation)
    if (coordinator !== undefined) return resolvedId(coordinator)
    return projectPreset.get(conversation) ?? defaultId
  }
  const resolved = (conversation: number): PresetView | undefined =>
    viewOf(resolvedId(conversation)) ?? viewOf(defaultId)

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

  const reconcile = async (): Promise<WorkspaceState | undefined> => {
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    if (workspace === undefined) return undefined
    projectOf.clear()
    projectPreset.clear()
    for (const project of Object.values(workspace.projects)) {
      const coordinator = project.coordinatorId
      projectPreset.set(coordinator, project.preset)
      for (const threadId of project.threadIds) projectOf.set(threadId, coordinator)
    }
    return workspace
  }

  const applyRecorded = async (workspace: WorkspaceState): Promise<void> => {
    const installed = port.extensions()
    const root = await port.harness.conversation(ROOT_CONVERSATION_ID, context)
    if (root !== undefined) await align(root.id, resolved(root.id), installed)
    for (const { conversationId } of entriesOf(workspace))
      await align(conversationId, resolved(conversationId), installed)
  }

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
      ids.add(ROOT_CONVERSATION_ID)
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
      const workspace = await reconcile()
      if (workspace === undefined) return { kind: "bad_args", reason: "Home is not ready" } as const
      if (
        conversationId !== ROOT_CONVERSATION_ID &&
        !entriesOf(workspace).some((entry) => entry.conversationId === conversationId)
      )
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
      await applyRecorded(workspace)
      return { kind: "selected", conversation: conversationId as ConversationId, preset } as const
    })

  const forget = (conversationId: number): Promise<void> =>
    enqueue(async () => {
      if (!records.has(conversationId)) return
      records.delete(conversationId)
      await port.db.run("DELETE FROM presets WHERE conversation = ?", conversationId)
      const workspace = await reconcile()
      if (workspace !== undefined) await applyRecorded(workspace)
    })

  const conversations = async (): Promise<readonly ConversationPresetView[]> => {
    const workspace = await reconcile()
    if (workspace === undefined) return []
    const ids = new Set<number>(records.keys())
    for (const { conversationId } of entriesOf(workspace)) ids.add(conversationId)
    return [...ids]
      .map((conversation) => ({ conversation: conversation as ConversationId, preset: resolvedId(conversation) }))
      .toSorted((left, right) => left.conversation - right.conversation)
  }

  const service: PresetsService = {
    list,
    presetOf: (conversation) => resolved(conversation),
    contribute,
  }

  return { service, applyAll, select, forget, conversations, clear }
}
