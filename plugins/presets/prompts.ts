import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { compile, int, map, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import { createContributions } from "../../src/contributions.ts"
import {
  MAX_PROMPT_NAME,
  MAX_PROMPT_TEXT,
  PROMPT_NAME_PATTERN,
  type Prompt,
  type PromptEntry,
  type PromptsService,
} from "../../src/contracts/prompts.ts"
import { presetAllows, type PresetView } from "../../src/contracts/presets.ts"
import { defineOp, type Op } from "../../src/ops.ts"
import { serial } from "../../src/serial.ts"

const PROMPTS_KEY = "prompts"
const PROMPT_NAME = new RegExp(PROMPT_NAME_PATTERN)

const StoredSchema = obj({ description: opt(str()), text: str() })
type StoredPrompt = Static<typeof StoredSchema>
const storedCheck = compile(map(StoredSchema))

const byName = (left: PromptEntry, right: PromptEntry): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

const json = (entry: PromptEntry) => ({
  name: entry.name,
  ...(entry.description === undefined ? {} : { description: entry.description }),
  text: entry.text,
  source: entry.source.kind === "stored" ? { kind: "stored" } : { kind: "row", row: entry.source.row },
})

export type PromptsPort = {
  readonly db: SqliteDatabase
  /** The preset a conversation resolves to, for filtering contributed prompts by plugin. */
  readonly presetOf: (conversation: number) => PresetView | undefined
  /** The plugin a row belongs to, or undefined when the row is kernel-owned. */
  readonly pluginOf: (row: string) => string | undefined
}

export type PromptsModule = {
  readonly service: PromptsService
  readonly ops: readonly Op[]
}

export function createPrompts(port: PromptsPort): PromptsModule {
  const contributed = createContributions<Prompt>({
    key: (prompt) => prompt.name,
    label: (name) => `prompt "${name}"`,
  })

  const readStored = async (): Promise<Map<string, StoredPrompt>> => {
    const row = await port.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", PROMPTS_KEY)
    if (row === undefined) return new Map()
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      throw new Error("stored prompts are corrupt")
    }
    if (!storedCheck.check(value)) throw new Error("stored prompts are corrupt")
    return new Map(Object.entries(value))
  }

  const writeStored = (prompts: ReadonlyMap<string, StoredPrompt>): Promise<void> =>
    port.db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      PROMPTS_KEY,
      JSON.stringify(Object.fromEntries(prompts)),
    )

  const list = async (): Promise<readonly PromptEntry[]> => {
    const entries = new Map<string, PromptEntry>()
    for (const { value, source } of contributed.entries())
      entries.set(value.name, { ...value, source: { kind: "row", row: source } })
    for (const [name, value] of await readStored()) entries.set(name, { name, ...value, source: { kind: "stored" } })
    return [...entries.values()].toSorted(byName)
  }

  const contribute = (prompt: Prompt, source: string): (() => void) => {
    if (!PROMPT_NAME.test(prompt.name)) throw new Error(`prompt name "${prompt.name}" must be lowercase letters, digits and hyphens`)
    if (prompt.name.length > MAX_PROMPT_NAME) throw new Error(`prompt name "${prompt.name}" is too long`)
    if (prompt.text.length > MAX_PROMPT_TEXT) throw new Error(`prompt "${prompt.name}" text is too long`)
    return contributed.add(source, prompt)
  }

  const visible = async (conversation: number | undefined): Promise<readonly PromptEntry[]> => {
    const entries = await list()
    if (conversation === undefined) return entries
    const preset = port.presetOf(conversation)
    return entries.filter(
      (entry) => entry.source.kind === "stored" || presetAllows(preset, port.pluginOf(entry.source.row)),
    )
  }

  const listOp: Op = defineOp({
    name: "prompt.list",
    args: obj({ conversation: opt(int({ minimum: 0 })) }),
    actors: ["owner"],
    run: async (_api, args) => (await visible(args.conversation)).map(json),
  })

  const mutate = serial()

  const write = (work: (prompts: Map<string, StoredPrompt>) => void): Promise<void> =>
    mutate(async () => {
      const prompts = await readStored()
      work(prompts)
      await writeStored(prompts)
    })

  const putOp: Op = defineOp({
    name: "prompt.put",
    args: obj({
      name: str({ pattern: PROMPT_NAME_PATTERN, maxLength: MAX_PROMPT_NAME }),
      description: opt(str()),
      text: str({ maxLength: MAX_PROMPT_TEXT }),
    }),
    actors: ["owner"],
    run: async (_api, { name, description, text }) => {
      const prompt: StoredPrompt = { text, ...(description === undefined ? {} : { description }) }
      await write((prompts) => prompts.set(name, prompt))
      return { name, ...prompt, source: { kind: "stored" } }
    },
  })

  const deleteOp: Op = defineOp({
    name: "prompt.delete",
    args: obj({ name: str({ pattern: PROMPT_NAME_PATTERN, maxLength: MAX_PROMPT_NAME }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      await write((prompts) => prompts.delete(name))
      return { name }
    },
  })

  return { service: { list, contribute }, ops: [listOp, putOp, deleteOp] }
}
