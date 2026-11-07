import type { Context } from "@deepseek-ai/cordis"
import Schema from "@deepseek-ai/schemastery"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import type { Catalog } from "../../src/kernel/loader.ts"
import { defineOp } from "../../src/ops.ts"

const safe = (row: string): string => row.replaceAll(/[^A-Za-z0-9_-]/g, "_")

const echo = {
  name: "k-echo",
  inject: ["pi", "host"],
  Config: Schema.object({ text: Schema.string().default("") }),
  apply(ctx: Context, config: { text: string }) {
    const row = ctx.get("loader")?.locate(ctx.fiber) ?? "k-echo"
    const kv = ctx.host.state.storage.kv
    const key = `k-echo:${row}`
    kv.put(key, config.text)
    ctx.effect(() => () => void kv.delete(key))
    ctx.pi.install(
      defineExtension({
        name: `tool-echo-${safe(row)}`,
        tools: [
          defineTool({
            name: `echo_${safe(row)}`,
            description: "Return the configured text.",
            parameters: obj({}),
            replay: "safe",
            execute: async () => ({ output: [{ type: "text", text: config.text }] }),
          }),
        ],
      }),
    )
  },
}

const broken = {
  name: "k-bundle-broken",
  inject: ["pi"],
  apply() {
    throw new Error("bundle row exploded")
  },
}

const secret = {
  name: "k-secret",
  inject: ["ops", "secrets"],
  apply(ctx: Context) {
    ctx.ops.define(
      defineOp({
        name: "k.secret",
        args: obj({}),
        actors: ["owner"],
        run: async () => ({ value: ctx.secrets.get("TOKEN") ?? null }),
      }),
    )
  },
}

export const catalog: Catalog = {
  "k-echo": {
    plugin: echo,
    title: "Echo bundle row",
    description: "Records its config and installs an echo tool for its row id.",
    multiple: true,
    source: "test",
  },
  "k-bundle-broken": {
    plugin: broken,
    title: "Broken bundle row",
    description: "Throws on start.",
    source: "test",
  },
  "k-secret": {
    plugin: secret,
    title: "Secret bundle row",
    description: "Reads its own TOKEN secret.",
    source: "test",
  },
}
