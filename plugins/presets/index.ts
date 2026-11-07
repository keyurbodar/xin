import type { JsonValue } from "@earendil-works/chord"
import { compile, int, map, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import type { PresetView } from "../../src/contracts/presets.ts"
import { type Context, defineOp, OpRejected, Schema } from "../../src/kernel/index.ts"
import { serial } from "../../src/serial.ts"
import { createPresets, MIGRATIONS, type PresetConfig } from "./presets.ts"

export const name = "presets"
export const inject = ["db", "harness", "pi", "ops"]
export const Config = Schema.object({
  default: Schema.string().default("full").description("The preset a new conversation runs until it is changed."),
})

const SelectArgs = obj({ conversation: int({ minimum: 0 }), preset: str({ minLength: 1 }) })

const PROMPTS_KEY = "prompts"
const PROMPT_NAME = "^[a-z][a-z0-9-]*$"
const MAX_PROMPT_NAME = 64
const MAX_PROMPT_TEXT = 8_000

const PromptSchema = obj({ description: opt(str()), text: str() })
type Prompt = Static<typeof PromptSchema>
const promptsCheck = compile(map(PromptSchema))
const PromptName = str({ pattern: PROMPT_NAME, maxLength: MAX_PROMPT_NAME })

const promptOrder = ([left]: readonly [string, Prompt], [right]: readonly [string, Prompt]): number =>
  left < right ? -1 : left > right ? 1 : 0

const promptJson = (promptName: string, prompt: Prompt): JsonValue => ({
  name: promptName,
  ...(prompt.description === undefined ? {} : { description: prompt.description }),
  text: prompt.text,
})

const viewJson = (view: PresetView): JsonValue => ({
  id: view.id,
  ...(view.name === undefined ? {} : { name: view.name }),
  ...(view.description === undefined ? {} : { description: view.description }),
  ...(view.order === undefined ? {} : { order: view.order }),
  tools: view.tools === "all" ? "all" : [...view.tools],
})

export async function apply(ctx: Context, config: PresetConfig): Promise<void> {
  await ctx.db.applySqliteMigrations("presets", MIGRATIONS)
  const feature = await createPresets({
    db: ctx.db,
    harness: ctx.harness,
    extensions: () => [...ctx.pi.installed.values()],
    config,
  })
  ctx.provide("presets", feature.service)

  const report = (): void => {
    void feature.applyAll().catch((error: unknown) => console.warn("presets: apply failed", error))
  }

  const observation = ctx.harness.observeCommits({
    advance: (publication) => {
      for (const change of publication.changes) {
        if (change.type === "document" && change.kind === "change" && change.record.kind === "xin.workspace") {
          report()
          return
        }
      }
    },
    end: () => undefined,
  })
  ctx.effect(() => () => observation.detach(), "presets.observe")
  ctx.effect(() => () => feature.clear(), "presets.restore")
  ctx.on("plugins/changed", () => report())

  ctx.on("ops/before", async (call, next) => {
    if (call.command.op === "project.create") {
      const wanted: unknown =
        typeof call.command.args === "object" && call.command.args !== null
          ? Reflect.get(call.command.args, "preset")
          : undefined
      if (typeof wanted === "string" && !feature.service.list().some((preset) => preset.id === wanted))
        return { kind: "rejected", code: "bad_args", message: `unknown preset: ${wanted}` }
    }
    const outcome = await next()
    if (call.command.op === "project.create" && outcome.kind === "ok")
      await feature.applyAll().catch((error: unknown) => console.warn("presets: apply failed", error))
    return outcome
  })

  ctx.ops.define(
    defineOp({
      name: "preset.list",
      args: obj({}),
      actors: ["owner"],
      run: async () => ({
        presets: feature.service.list().map(viewJson),
        default: config.default,
        conversations: [...(await feature.conversations())],
      }),
    }),
  )

  ctx.ops.define(
    defineOp({
      name: "preset.select",
      args: SelectArgs,
      actors: ["owner"],
      run: async (_api, args) => {
        const outcome = await feature.select(args.conversation, args.preset)
        switch (outcome.kind) {
          case "bad_args":
            throw new OpRejected("bad_args", outcome.reason)
          case "selected":
            return { conversation: outcome.conversation, preset: outcome.preset.id }
        }
      },
    }),
  )

  const readPrompts = async (): Promise<Map<string, Prompt>> => {
    const row = await ctx.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", PROMPTS_KEY)
    if (row === undefined) return new Map()
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      throw new Error("stored prompts are corrupt")
    }
    if (!promptsCheck.check(value)) throw new Error("stored prompts are corrupt")
    return new Map(Object.entries(value))
  }

  const writePrompts = (prompts: ReadonlyMap<string, Prompt>): Promise<void> =>
    ctx.db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      PROMPTS_KEY,
      JSON.stringify(Object.fromEntries(prompts)),
    )

  ctx.ops.define(
    defineOp({
      name: "prompt.list",
      args: obj({}),
      actors: ["owner"],
      run: async () =>
        [...(await readPrompts()).entries()]
          .toSorted(promptOrder)
          .map(([promptName, prompt]) => promptJson(promptName, prompt)),
    }),
  )

  const mutatePrompt = serial()

  ctx.ops.define(
    defineOp({
      name: "prompt.put",
      args: obj({
        name: PromptName,
        description: opt(str()),
        text: str({ maxLength: MAX_PROMPT_TEXT }),
      }),
      actors: ["owner"],
      run: async (_api, { name: promptName, description, text }) =>
        mutatePrompt(async () => {
          const prompts = await readPrompts()
          const prompt: Prompt = { text, ...(description === undefined ? {} : { description }) }
          prompts.set(promptName, prompt)
          await writePrompts(prompts)
          return promptJson(promptName, prompt)
        }),
    }),
  )

  ctx.ops.define(
    defineOp({
      name: "prompt.delete",
      args: obj({ name: PromptName }),
      actors: ["owner"],
      run: async (_api, { name: promptName }) =>
        mutatePrompt(async () => {
          const prompts = await readPrompts()
          prompts.delete(promptName)
          await writePrompts(prompts)
          return { name: promptName }
        }),
    }),
  )

  await feature.applyAll()
}
