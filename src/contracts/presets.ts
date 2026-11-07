import type { ConversationId } from "@earendil-works/pi-durable"
import type { ProjectId } from "../ids.ts"

export type PresetTools = "all" | readonly string[]

export type PresetPrompts = "all" | "none" | readonly string[]

export type PresetView = {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly tools: PresetTools
  readonly prompts: PresetPrompts
}

export type PresetContribution = {
  readonly id?: string
  readonly title: string
  readonly description: string
  readonly tools: PresetTools
  readonly prompts: PresetPrompts
}

export type ConversationPresetView = {
  readonly conversation: ConversationId
  readonly preset: PresetView
}

export type AssignTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "conversation"; readonly conversationId: ConversationId }

export type AssignOutcome =
  | { readonly kind: "assigned"; readonly target: AssignTarget; readonly preset: PresetView | null }
  | { readonly kind: "bad_args"; readonly reason: string }

export interface PresetsService {
  list(): readonly PresetView[]
  presetOf(projectId: ProjectId): PresetView
  contribute(preset: PresetContribution, source: string): Promise<() => Promise<void>>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    presets: PresetsService
  }
}
