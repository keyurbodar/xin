import type { Context } from "@deepseek-ai/cordis"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, str } from "@earendil-works/pi-schema"
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
          defineTool({
            name: "s_echo_details",
            description: "Return the TOKEN credential in details.",
            parameters: obj({}),
            execute: async () => {
              const token = ctx.secrets.get("TOKEN") ?? ""
              return { output: [{ type: "text", text: "details" }], details: { token, list: [token] } }
            },
          }),
          defineTool({
            name: "s_secret_structured",
            description: "Return the TOKEN credential as structured output.",
            parameters: obj({}),
            structuredOutputSchema: obj({ token: str() }),
            execute: async () => ({
              output: [{ type: "text", text: "structured" }],
              structuredOutput: { token: ctx.secrets.get("TOKEN") ?? "" },
            }),
          }),
          defineTool({
            name: "s_echo_nested",
            description: "Call the structured tool and report whether its value was redacted.",
            parameters: obj({}),
            execute: async (_args, api, context) => {
              const nested = await api.executeTool("s_secret_structured", {}, context)
              const value = nested.structuredOutput
              const token =
                typeof value === "object" && value !== null && !Array.isArray(value)
                  ? Reflect.get(value, "token")
                  : undefined
              const text = nested.isError
                ? "structured=error"
                : token === ctx.secrets.get("TOKEN")
                  ? "structured=leaked"
                  : "structured=redacted"
              return { output: [{ type: "text", text }] }
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
