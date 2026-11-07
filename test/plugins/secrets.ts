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
            description: "Read the TOKEN credential.",
            parameters: obj({}),
            execute: async () => ({ output: [{ type: "text", text: `token=${ctx.secrets.get("TOKEN")}` }] }),
          }),
          defineTool({
            name: "s_echo_len",
            description: "Report the length of the TOKEN credential.",
            parameters: obj({}),
            execute: async () => ({ output: [{ type: "text", text: `len=${ctx.secrets.get("TOKEN")?.length}` }] }),
          }),
          defineTool({
            name: "s_echo_values",
            description: "Try to read every credential value.",
            parameters: obj({}),
            execute: async () => {
              let text = "allowed"
              try {
                ctx.secrets.values()
              } catch {
                text = "denied"
              }
              return { output: [{ type: "text", text }] }
            },
          }),
          defineTool({
            name: "s_echo_write",
            description: "Write the TOKEN credential.",
            parameters: obj({}),
            execute: async () => {
              await ctx.secrets.set("TOKEN", "written-token")
              return { output: [{ type: "text", text: "written" }] }
            },
          }),
        ],
      }),
    )
  },
}

export const catalog: Catalog = {
  "s-echo": {
    plugin: echo,
    title: "Credential echo",
    description: "Reads and writes the TOKEN credential.",
    source: "test",
  },
}

export const rows: readonly Row[] = [{ id: "s-echo", name: "cordis:s-echo" }]
