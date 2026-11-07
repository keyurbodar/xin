import type { JsonValue } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { int, nullable, obj, str, union } from "@earendil-works/pi-schema"
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
      prompts: Schema.union([Schema.const("all"), Schema.const("none"), Schema.array(Schema.string())])
        .default("all")
        .description('"all", "none", or the prompt rows the preset offers.'),
    }),
  ).default({
    full: { title: "Full", description: "Every tool row.", tools: "all", prompts: "all" },
    minimal: {
      title: "Minimal",
      description: "Memory and skills only.",
      tools: ["tool-memory", "tool-skills"],
      prompts: "all",
    },
  } satisfies Record<string, PresetDefinition>),
})

const AssignArgs = union([
  obj({ projectId: str({ minLength: 1 }), preset: str({ minLength: 1 }) }),
  obj({ conversation: int({ minimum: 0 }), preset: nullable(str({ minLength: 1 })) }),
])

const viewJson = (view: PresetView): JsonValue => ({
  id: view.id,
  title: view.title,
  description: view.description,
  tools: view.tools === "all" ? "all" : [...view.tools],
  prompts: typeof view.prompts === "string" ? view.prompts : [...view.prompts],
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
        const conversations = (workspace === undefined ? [] : feature.conversations(workspace)).map(
          ({ conversation, preset }) => ({ conversation, preset: preset.id }),
        )
        return { presets: feature.service.list().map(viewJson), projects, conversations }
      },
    }),
  )

  ctx.ops.define(
    defineOp({
      name: "preset.assign",
      args: AssignArgs,
      actors: ["owner"],
      run: async (_api, args) => {
        const outcome =
          "conversation" in args
            ? await feature.assign({ kind: "conversation", id: args.conversation }, args.preset)
            : await feature.assign({ kind: "project", id: args.projectId }, args.preset)
        switch (outcome.kind) {
          case "bad_args":
            throw new OpRejected("bad_args", outcome.reason)
          case "assigned": {
            const preset = outcome.preset === null ? null : viewJson(outcome.preset)
            return outcome.target.kind === "project"
              ? { projectId: outcome.target.projectId, preset }
              : { conversation: outcome.target.conversationId, preset }
          }
        }
      },
    }),
  )

  await feature.applyAll()
}
