import { defineExtension, section } from "@earendil-works/pi-durable"
import { rowId } from "../../src/contributions.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "prompt"
export const inject = ["pi"]
export const Config = Schema.object({
  title: Schema.string().description("A label for the client; it does not reach the model."),
  text: Schema.string().required().max(16_384).description("The prompt section text, at most 16 KiB."),
})

type Config = { readonly title?: string; readonly text: string }

const ENCODER = new TextEncoder()
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

const hash = (text: string): string => {
  let value = FNV_OFFSET
  for (const byte of ENCODER.encode(text)) {
    value ^= BigInt(byte)
    value = BigInt.asUintN(64, value * FNV_PRIME)
  }
  return value.toString(16).padStart(16, "0")
}

export const extensionName = (row: string): string => `prompt-${hash(row)}`

export function apply(ctx: Context, config: Config): void {
  const key = extensionName(rowId(ctx))
  ctx.pi.install(defineExtension({ name: key, sections: [section(key, () => config.text)] }))
}
