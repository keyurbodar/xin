import type { Context } from "@deepseek-ai/cordis"
import type { IntakeBatchRow } from "../../src/contracts/intake.ts"
import { Schema } from "../../src/kernel/index.ts"
import type { Row } from "../../src/kernel/layers.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

export const MARK = "[intake-batch]"

export const Config = Schema.object({
  mode: Schema.union([Schema.const("rewrite"), Schema.const("drop")]).default("rewrite"),
})

type Mode = "rewrite" | "drop"

export const name = "intakebatch"

export function apply(ctx: Context, config: { readonly mode: Mode }): void {
  ctx.on("intake/batch", async (batch, next) => {
    if (config.mode === "drop") return { kind: "dropped", reason: "test drop" }
    batch.rows = batch.rows.map(annotate)
    return next()
  })
}

function annotate(row: IntakeBatchRow): IntakeBatchRow {
  return { ...row, text: `${MARK} ${row.text}` }
}

export const catalog: Catalog = {
  intakebatch: {
    plugin: { name, Config, apply },
    title: "Intake batch listener",
    description: "Test row that rewrites or drops a claimed intake batch.",
    source: "test",
  },
}

export const rows: readonly Row[] = [{ id: "intakebatch", name: "cordis:intakebatch", disabled: true }]
