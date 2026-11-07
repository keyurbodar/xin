import type { ConversationId } from "@earendil-works/pi-durable"

export type PresetTools = "all" | readonly string[]

export type PresetView = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly tools: PresetTools
}

export type ConversationPresetView = {
  readonly conversation: ConversationId
  readonly preset: string
}

export interface PresetsService {
  list(): readonly PresetView[]
  presetOf(conversation: ConversationId): PresetView | undefined
  contribute(preset: PresetView, source: string): Promise<() => Promise<void>>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    presets: PresetsService
  }
}
