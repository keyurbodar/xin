import type { Context } from "@deepseek-ai/cordis"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import type { Catalog } from "../../src/kernel/loader.ts"
import type { Row } from "../../src/kernel/layers.ts"

const echo = {
  name: "s-echo",
  inject: ["pi", "secrets"],
  apply(ctx: Context) {
    ctx.pi.install(
      defineExtension({
        name: "tool-s-echo",
        tools: [
          defineTool({
            name: "s_echo_secret",
            description: "Read this row's TOKEN secret.",
            parameters: obj({}),
            execute: async () => ({ output: [{ type: "text", text: `token=${ctx.secrets.get("TOKEN")}` }] }),
          }),
          defineTool({
            name: "s_echo_len",
            description: "Report the length of this row's TOKEN secret.",
            parameters: obj({}),
            execute: async () => ({ output: [{ type: "text", text: `len=${ctx.secrets.get("TOKEN")?.length}` }] }),
          }),
        ],
      }),
    )
  },
}

const other = {
  name: "s-other",
  inject: ["pi", "secrets"],
  apply(ctx: Context) {
    ctx.pi.install(
      defineExtension({
        name: "tool-s-other",
        tools: [
          defineTool({
            name: "s_other_secret",
            description: "Read this row's TOKEN secret.",
            parameters: obj({}),
            execute: async () => ({ output: [{ type: "text", text: `token=${ctx.secrets.get("TOKEN")}` }] }),
          }),
          defineTool({
            name: "s_other_values",
            description: "Try to read every row's secret values.",
            parameters: obj({}),
            execute: async () => {
              try {
                return { output: [{ type: "text" as const, text: `leaked=${ctx.secrets.values().length}` }] }
              } catch {
                return { output: [{ type: "text" as const, text: "denied" }] }
              }
            },
          }),
          defineTool({
            name: "s_other_write",
            description: "Write this row's TOKEN secret.",
            parameters: obj({}),
            execute: async () => {
              await ctx.secrets.set("TOKEN", "other-token")
              return { output: [{ type: "text", text: "written" }] }
            },
          }),
        ],
      }),
    )
  },
}

const entry = (plugin: Catalog[string]["plugin"], title: string) => ({
  plugin,
  title,
  description: title,
  source: "test",
})

export const catalog: Catalog = {
  "s-echo": entry(echo, "Secret echo"),
  "s-other": entry(other, "Secret other"),
}

export const rows: readonly Row[] = ["s-echo", "s-other"].map((id) => ({ id, name: `cordis:${id}` }))
