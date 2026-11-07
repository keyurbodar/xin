import type { JsonValue } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { obj, str } from "@earendil-works/pi-schema"
import type { PresetView } from "../../src/contracts/presets.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { ProjectId } from "../../src/ids.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"
import { defineOp, OpRejected } from "../../src/ops.ts"
import { createPresets, MIGRATIONS, type PresetConfig, type PresetDefinition } from "./presets.ts"

const context = BACKGROUND_CONTEXT

export const name = "presets"
export const inject = ["db", "harness", "pi", "ops"]
export const Config = Schema.object({
  default: Schema.string().default("full").description("The preset a project without an assignment uses."),
  presets: Schema.dict(
    Schema.object({
      title: Schema.string(),
      description: Schema.string(),
      tools: Schema.union([Schema.const("all"), Schema.array(Schema.string())]).description(
        '"all", or the tool rows the preset offers.',
      ),
    }),
  ).default({
    full: { title: "Full", description: "Every tool row.", tools: "all" },
    minimal: { title: "Minimal", description: "Memory and skills only.", tools: ["tool-memory", "tool-skills"] },
  } satisfies Record<string, PresetDefinition>),
})

const viewJson = (view: PresetView): JsonValue => ({
  id: view.id,
  title: view.title,
  description: view.description,
  tools: view.tools === "all" ? "all" : [...view.tools],
})

export async function apply(ctx: Context, config: PresetConfig): Promise<void> {
  await ctx.db.applySqliteMigrations("presets", MIGRATIONS)
  const feature = await createPresets({
    db: ctx.db,
    harness: ctx.harness,
    extensions: () => [...ctx.pi.installed.values()].map((installed) => installed.extension),
    config,
  })
  ctx.provide("presets", feature.service)

  const schedule = (): Promise<void> => feature.applyAll()
  const report = (): void => {
    void schedule().catch((error: unknown) => console.warn("presets: apply failed", error))
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

  ctx.ops.define(
    defineOp({
      name: "preset.list",
      args: obj({}),
      actors: ["owner"],
      run: async () => {
        const workspace = await ctx.harness.snapshot(WorkspaceDoc, context)
        const projects = Object.keys(workspace?.projects ?? {}).map((projectId) => ({
          projectId,
          preset: feature.service.presetOf(projectId as ProjectId).id,
        }))
        return { presets: feature.service.list().map(viewJson), projects }
      },
    }),
  )

  ctx.ops.define(
    defineOp({
      name: "preset.assign",
      args: obj({ projectId: str({ minLength: 1 }), preset: str({ minLength: 1 }) }),
      actors: ["owner"],
      run: async (_api, args) => {
        const outcome = await feature.assign(args.projectId, args.preset)
        switch (outcome.kind) {
          case "bad_args":
            throw new OpRejected("bad_args", outcome.reason)
          case "assigned":
            return { projectId: outcome.projectId, preset: viewJson(outcome.preset) }
        }
      },
    }),
  )

  await feature.applyAll()
}
