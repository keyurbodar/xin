import type { JsonValue } from "@earendil-works/chord"
import type { ConversationId } from "@earendil-works/pi-durable"
import { int, obj, str } from "@earendil-works/pi-schema"
import type { PresetView } from "../../src/contracts/presets.ts"
import { type Context, defineOp, OpRejected, Schema } from "../../src/kernel/index.ts"
import { createPresets, MIGRATIONS, type PresetConfig } from "./presets.ts"
import { createPrompts } from "./prompts.ts"

export const name = "presets"
export const inject = ["db", "harness", "kernel", "pi", "ops"]
export const Config = Schema.object({
  default: Schema.string().default("full").description("The preset a new conversation runs until it is changed."),
})

const SelectArgs = obj({ conversation: int({ minimum: 0 }), preset: str({ minLength: 1 }) })

const viewJson = (view: PresetView): JsonValue => ({
  id: view.id,
  ...(view.name === undefined ? {} : { name: view.name }),
  ...(view.description === undefined ? {} : { description: view.description }),
  ...(view.order === undefined ? {} : { order: view.order }),
  plugins: view.plugins === "all" ? "all" : [...view.plugins],
})

export async function apply(ctx: Context, config: PresetConfig): Promise<void> {
  await ctx.db.applySqliteMigrations("presets", MIGRATIONS)
  const feature = await createPresets({
    db: ctx.db,
    harness: ctx.harness,
    extensions: () =>
      [...ctx.pi.installed.values()].map(({ extension, row }) => ({
        extension,
        plugin: row === undefined ? undefined : ctx.kernel.pluginOfRow(row),
      })),
    config,
  })
  ctx.provide("presets", feature.service)

  const prompts = createPrompts({
    db: ctx.db,
    presetOf: (conversation) => feature.service.presetOf(conversation as ConversationId),
    pluginOf: (row) => ctx.kernel.pluginOfRow(row),
  })
  ctx.provide("prompts", prompts.service)
  for (const op of prompts.ops) ctx.ops.define(op)

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
    const op = call.command.op
    const scoped = op === "project.create" || op === "project.update"
    const wanted: unknown =
      scoped && typeof call.command.args === "object" && call.command.args !== null
        ? Reflect.get(call.command.args, "preset")
        : undefined
    if (typeof wanted === "string" && !feature.service.list().some((preset) => preset.id === wanted))
      return { kind: "rejected", code: "bad_args", message: `unknown preset: ${wanted}` }
    const outcome = await next()
    if (outcome.kind === "ok" && (op === "project.create" || (op === "project.update" && wanted !== undefined))) {
      if (op === "project.update") {
        const result: unknown = outcome.result
        const coordinator = typeof result === "object" && result !== null ? Reflect.get(result, "coordinatorId") : undefined
        if (typeof coordinator === "number") await feature.forget(coordinator)
      }
      await feature.applyAll().catch((error: unknown) => console.warn("presets: apply failed", error))
    }
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

  await feature.applyAll()
}
