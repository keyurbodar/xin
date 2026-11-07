import { rowId } from "../../src/contributions.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"
import { skillOf } from "./skills.ts"

export const name = "skill"
export const inject = ["skills"]
export const Config = Schema.object({
  markdown: Schema.string()
    .required()
    .max(65_536)
    .description("A skill file: --- frontmatter with name and description, then the body."),
})

type Config = { readonly markdown: string }

export async function apply(ctx: Context, config: Config): Promise<void> {
  const row = rowId(ctx)
  const skill = skillOf(config.markdown)
  const existing = (await ctx.skills.list()).find((other) => other.name === skill.name)
  if (existing !== undefined)
    throw new Error(
      existing.source.kind === "stored"
        ? `skill "${skill.name}" is already stored; the stored skill wins`
        : `skill "${skill.name}" is already provided by ${existing.source.kind === "row" ? existing.source.row : "the build"}`,
    )
  ctx.effect(() => ctx.skills.contribute(skill, row), "skill.contribute")
}
