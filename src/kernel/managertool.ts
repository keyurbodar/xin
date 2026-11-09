import { defineExtension, defineTool, type Extension, type JsonObject } from "@earendil-works/pi-durable"
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import type { Context } from "@deepseek-ai/cordis"
import { OpRejected } from "../ops.ts"
import type { Manager } from "./manager.ts"

const READS = ["list", "catalog", "tree", "doctor"] as const
const ACTIONS = [...READS, "enable", "configure"] as const

const text = (value: unknown, isError = false) => ({
  output: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
  ...(isError ? { isError: true } : {}),
})

function pluginManagerTool(manager: Manager): Extension {
  return defineExtension({
    name: "tool-plugins",
    tools: [
      defineTool({
        name: "plugin_manager",
        description:
          "Inspect and change Xin's plugin rows: list, catalog, tree, doctor, enable {id, enabled}, configure {id, config}. Changes apply live; tell the owner what you changed.",
        parameters: obj({
          action: oneOf(ACTIONS),
          id: opt(str({ minLength: 1 })),
          enabled: opt(bool()),
          config: opt(obj({}, { open: true })),
        }),
        execute: async ({ action, id, enabled, config }) => {
          try {
            switch (action) {
              case "list":
                return text(await manager.list())
              case "catalog":
                return text(manager.catalog())
              case "tree":
                return text(manager.tree())
              case "doctor":
                return text(await manager.doctor())
              case "enable":
                if (id === undefined || enabled === undefined)
                  return text({ error: "enable needs id and enabled" }, true)
                return text(await manager.enable(id, enabled))
              case "configure": {
                if (id === undefined || config === undefined)
                  return text({ error: "configure needs id and config" }, true)
                const value: JsonObject = config
                return text(await manager.configure(id, value))
              }
              default: {
                const _exhaustive: never = action
                return _exhaustive
              }
            }
          } catch (error) {
            if (error instanceof OpRejected) return text({ error: error.code, message: error.message }, true)
            throw error
          }
        },
      }),
    ],
  })
}

export const name = "tool-plugins"
export const inject = ["pi", "plugins"]

export function apply(ctx: Context): void {
  ctx.pi.install(pluginManagerTool(ctx.plugins))
}
