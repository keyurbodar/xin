import type { ProjectId } from "../ids.ts"

export type PresetTools = "all" | readonly string[]

export type PresetView = {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly tools: PresetTools
}

export type AssignOutcome =
  | { readonly kind: "assigned"; readonly projectId: ProjectId; readonly preset: PresetView }
  | { readonly kind: "bad_args"; readonly reason: string }

export interface PresetsService {
  list(): readonly PresetView[]
  presetOf(projectId: ProjectId): PresetView
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    presets: PresetsService
  }
}
