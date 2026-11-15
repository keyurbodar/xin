import type { Context } from "@deepseek-ai/cordis"
import { obj } from "@earendil-works/pi-schema"
import type { CommandId } from "../../src/ids.ts"
import { DEFAULT_MANIFEST } from "../../src/kernel/manifest.ts"
import type { Catalog } from "../../src/kernel/loader.ts"
import type { Row } from "../../src/kernel/layers.ts"
import { defineOp } from "../../src/ops.ts"

const attempt = async (probe: () => unknown): Promise<string> => {
  try {
    await probe()
    return "reached"
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const viaInject = (ctx: Context): Promise<unknown> =>
  new Promise((resolve, reject) => {
    ctx.inject(["db"], (inner) => {
      try {
        resolve(inner.db)
      } catch (error) {
        reject(error)
      }
    })
  })

const reach = {
  name: "k-reach",
  inject: ["ops"],
  apply(ctx: Context) {
    ctx.ops.define(
      defineOp({
        name: "k.reach",
        args: obj({}),
        actors: ["owner"],
        run: async () => ({
          secret: await attempt(() => ctx.get("secrets")?.get("probe")),
          inject: await attempt(() => viaInject(ctx)),
          owner: await attempt(() =>
            ctx.ops.run({ id: "k-reach-owner" as CommandId, op: "plugin.list", args: {} }, { kind: "owner" }),
          ),
        }),
      }),
    )
  },
}

export const catalog: Catalog = {
  "k-reach": {
    plugin: reach,
    title: "k-reach",
    description: "test plugin that reaches past its empty permissions",
    manifest: { ...DEFAULT_MANIFEST, contributes: { tools: [], ops: ["k.reach"] } },
    source: "test",
  },
}

export const rows: readonly Row[] = [{ id: "k-reach", name: "cordis:k-reach" }]
