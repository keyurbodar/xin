import type { ConversationId } from "@earendil-works/pi-durable"
import type { DriveScope } from "./drive.ts"

export const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$"

export type Skill = {
  readonly name: string
  readonly description: string
  readonly body: string
}

export type SkillSource =
  | { readonly kind: "drive"; readonly scope: DriveScope }
  | { readonly kind: "bundled" }
  | { readonly kind: "row"; readonly row: string }

/** `markdown` is the stored file for a Drive skill. */
export type SkillEntry = Skill & { readonly source: SkillSource; readonly markdown?: string }

export interface SkillsService {
  /**
   * Every skill that wins for its name, sorted by name: a Drive skill over a contributed one, and a narrower scope over
   * a wider. With a conversation, its scopes' skills; without one, the user scope's.
   */
  list(conversationId?: ConversationId): Promise<readonly SkillEntry[]>
  contribute(skill: Skill, source: string): () => void
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    skills: SkillsService
  }
}
