import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { rowId } from "../../src/contributions.ts"
import { type Context, Schema, textResult } from "../../src/kernel/index.ts"

export const name = "hello"
export const inject = ["pi", "prompts"]

export const Config = Schema.object({
  greeting: Schema.string().default("Hi").description("The word the tool opens with."),
})

type Config = { readonly greeting: string }

export function apply(ctx: Context, config: Config): void {
  ctx.pi.install(
    defineExtension({
      name: `tool-${name}`,
      tools: [
        defineTool({
          name: "hello",
          description: "Greet the owner with the greeting this plugin is configured with.",
          parameters: obj({
            who: opt(str({ minLength: 1, maxLength: 64, description: "Who to greet. The owner by default." })),
          }),
          replay: "safe",
          execute: async (args) => textResult(`${config.greeting}, ${args.who ?? "owner"}!`),
        }),
      ],
    }),
  )
  ctx.prompts.contribute(
    {
      name: "hello",
      description: "Greet me with the hello tool.",
      text: "Greet me with the hello tool, then tell me which greeting the plugin is configured with.",
    },
    rowId(ctx),
  )
}
