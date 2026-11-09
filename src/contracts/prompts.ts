export const PROMPT_NAME_PATTERN = "^[a-z][a-z0-9-]*$"
export const MAX_PROMPT_NAME = 64
export const MAX_PROMPT_TEXT = 8_000

export type Prompt = {
  readonly name: string
  readonly description?: string
  readonly text: string
}

export type PromptSource = { readonly kind: "stored" } | { readonly kind: "row"; readonly row: string }

export type PromptEntry = Prompt & { readonly source: PromptSource }

export interface PromptsService {
  /** Every prompt that wins for its name, sorted by name. A stored prompt wins over a contributed one. */
  list(): Promise<readonly PromptEntry[]>
  /** Add a prompt owned by a plugin row. Returns its disposer. */
  contribute(prompt: Prompt, source: string): () => void
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    prompts: PromptsService
  }
}
