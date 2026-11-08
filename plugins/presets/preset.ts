import { rowId } from "../../src/contributions.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "preset"
export const inject = ["presets"]

export const Config = Schema.object({
  id: Schema.string().required().description("The preset id a conversation records."),
  name: Schema.string().description("Display name."),
  description: Schema.string().description("One sentence on what this preset is for."),
  order: Schema.number().description("Position in preset.list; lower comes first."),
  tools: Schema.union([Schema.const("all"), Schema.array(Schema.string())])
    .required()
    .description('"all", or the tool extensions the preset offers.'),
})

type Config = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly tools: "all" | readonly string[]
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  return ctx.presets.contribute(
    {
      id: config.id,
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.description === undefined ? {} : { description: config.description }),
      ...(config.order === undefined ? {} : { order: config.order }),
      tools: config.tools,
    },
    rowId(ctx),
  )
}
