import { defineExtension, defineTool, type Extension, type JsonObject } from "@earendil-works/pi-durable"
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import { OpRejected } from "../ops.ts"
import type { Manager } from "./manager.ts"

const READS = ["list", "catalog", "tree"] as const
const ACTIONS = [...READS, "enable", "configure"] as const

type Action = (typeof ACTIONS)[number]

const isRead = (action: Action): boolean => READS.some((read) => read === action)

const text = (value: unknown, isError = false) => ({
  output: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
  ...(isError ? { isError: true } : {}),
})

export function pluginManagerTool(manager: Manager, allowAgent: boolean): Extension {
  return defineExtension({
    name: "plugins.tool",
    tools: [
      defineTool({
        name: "plugin_manager",
        description: allowAgent
          ? "Inspect and change Xin's plugin rows: list, catalog, tree, enable {id, enabled}, configure {id, config}. Changes apply live; tell the owner what you changed."
          : "Inspect Xin's plugin rows: list, catalog, tree. Changing plugins is owner-only; tell the owner which plugin.* op to run.",
        parameters: obj({
          action: oneOf(ACTIONS),
          id: opt(str({ minLength: 1 })),
          enabled: opt(bool()),
          config: opt(obj({}, { open: true })),
        }),
        execute: async ({ action, id, enabled, config }) => {
          if (!isRead(action) && !allowAgent)
            return text(
              { error: "forbidden", message: `${action} is owner-only; ask the owner to run plugin.${action}` },
              true,
            )
          try {
            switch (action) {
              case "list":
                return text(await manager.list())
              case "catalog":
                return text(manager.catalog())
              case "tree":
                return text(manager.tree())
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
