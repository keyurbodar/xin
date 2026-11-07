import type { JsonValue } from "@earendil-works/chord"
import { int, obj, str } from "@earendil-works/pi-schema"
import type { PresetView } from "../../src/contracts/presets.ts"
import { type Context, defineOp, OpRejected, Schema } from "../../src/kernel/index.ts"
import { createPresets, MIGRATIONS, type PresetConfig } from "./presets.ts"

export const name = "presets"
export const inject = ["db", "harness", "pi", "ops"]
export const Config = Schema.object({
  default: Schema.string().default("full").description("The preset a new conversation runs until it is changed."),
})

const SelectArgs = obj({ conversation: int({ minimum: 0 }), preset: str({ minLength: 1 }) })

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

  await feature.applyAll()
}
