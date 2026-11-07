import { rowId } from "../../src/contributions.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "preset"
export const inject = ["presets"]

export const Config = Schema.object({
  id: Schema.string().description("The preset id. Defaults to this row's id."),
  title: Schema.string().required(),
  description: Schema.string().required(),
  tools: Schema.union([Schema.const("all"), Schema.array(Schema.string())])
    .required()
    .description('"all", or the tool rows the preset offers.'),
})

type Config = {
  readonly id?: string
  readonly title: string
  readonly description: string
  readonly tools: "all" | readonly string[]
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const row = rowId(ctx)
  return ctx.presets.contribute(
    {
      ...(config.id === undefined ? {} : { id: config.id }),
      title: config.title,
      description: config.description,
      tools: config.tools,
    },
    row,
  )
}
