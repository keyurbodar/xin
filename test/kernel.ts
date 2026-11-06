import type { Context } from "@deepseek-ai/cordis"
import type { Extension } from "@earendil-works/pi-durable"
import type { CatalogEntry } from "../src/kernel/loader.ts"
import type { Op } from "../src/ops.ts"

export type Parts = { readonly extensions?: readonly Extension[]; readonly ops?: readonly Op[] }

export function testPlugin(name: string, parts: Parts, inject: readonly string[] = ["pi", "ops"]): CatalogEntry {
  return {
    plugin: {
      name,
      inject: [...inject],
      apply(ctx: Context) {
        for (const extension of parts.extensions ?? []) ctx.pi.install(extension)
        for (const op of parts.ops ?? []) ctx.ops.define(op)
      },
    },
    title: name,
    description: `test plugin ${name}`,
    source: "test",
  }
}
