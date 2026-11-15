import type { ConversationId, Extension } from "@earendil-works/pi-durable"

export type PresetPlugins = "all" | readonly string[]

export type PresetView = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: PresetPlugins
}

export type ConversationPresetView = {
  readonly conversation: ConversationId
  readonly preset: string
}

export interface PresetsService {
  list(): readonly PresetView[]
  presetOf(conversation: ConversationId): PresetView | undefined
  /** The extensions a new thread of `coordinator` starts without, so its first request is already lean. */
  threadRemovals(coordinator: ConversationId): readonly Extension[]
  contribute(preset: PresetView, source: string): Promise<() => Promise<void>>
}

/** Whether a preset keeps a contribution from `plugin`. An unknown plugin (kernel-owned) is always kept. */
export const presetAllows = (preset: PresetView | undefined, plugin: string | undefined): boolean =>
  preset === undefined || preset.plugins === "all" || plugin === undefined || preset.plugins.includes(plugin)

declare module "@deepseek-ai/cordis" {
  interface Context {
    presets: PresetsService
  }
}
