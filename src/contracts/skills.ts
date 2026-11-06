export const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$"

export type Skill = {
  readonly name: string
  readonly description: string
  readonly body: string
}

export interface SkillsService {
  /** Every skill the owner can load, sorted by name. */
  list(): Promise<readonly Skill[]>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    skills: SkillsService
  }
}
