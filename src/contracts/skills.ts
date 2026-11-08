export const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$"

export type Skill = {
  readonly name: string
  readonly description: string
  readonly body: string
}

export type SkillSource =
  | { readonly kind: "stored" }
  | { readonly kind: "bundled" }
  | { readonly kind: "row"; readonly row: string }

export type SkillEntry = Skill & { readonly source: SkillSource }

export interface SkillsService {
  /** Every skill that wins for its name, sorted by name. A stored skill wins over a contributed one. */
  list(): Promise<readonly SkillEntry[]>
  contribute(skill: Skill, source: string): () => void
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    skills: SkillsService
  }
}
