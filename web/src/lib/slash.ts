import type { Prompt } from "../state/extensions.ts"

/** `/name rest` becomes the prompt's text followed by the rest; a name no prompt owns is left as typed. */
export function expandSlash(text: string, prompts: readonly Prompt[]): string {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim())
  if (match === null) return text
  const [, name, rest = ""] = match
  const prompt = prompts.find((entry) => entry.name === name)
  if (prompt === undefined) return text
  const tail = rest.trim()
  return tail === "" ? prompt.text : `${prompt.text}\n\n${tail}`
}
