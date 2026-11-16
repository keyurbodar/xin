// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, str } from "@earendil-works/pi-schema"
import { type Context, textResult } from "../../src/kernel/index.ts"
import { SHOW_VISUAL_DESCRIPTION } from "./description.ts"
import { check } from "./runtime/check.ts"
import { MAX_SCRIPT_BYTES, seedFor } from "./runtime/lua.ts"

export const name = "visual"
export const inject = ["pi"]

export function apply(ctx: Context): void {
  ctx.pi.install(
    defineExtension({
      name: `tool-${name}`,
      tools: [
        defineTool({
          name: "show_visual",
          description: SHOW_VISUAL_DESCRIPTION,
          parameters: obj({
            title: str({
              minLength: 1,
              maxLength: 120,
              description: "A short name for the visual, for the reader's screen reader and the copy menu.",
            }),
            script: str({ minLength: 1, maxLength: MAX_SCRIPT_BYTES, description: "The Lua 5.3 visual script." }),
          }),
          replay: "safe",
          execute: async (args, api) => {
            let report
            try {
              report = check(args.script, seedFor(api.callId))
            } catch (error) {
              return textResult(`visual script failed: ${error instanceof Error ? error.message : String(error)}`, {
                isError: true,
              })
            }
            const logs = report.logs.length === 0 ? "" : `\nprint output:\n${report.logs.join("\n")}`
            return textResult(`Shown. ${report.nodes} nodes; ${report.interactions} interactions checked.${logs}`, {
              details: { nodes: report.nodes, interactions: report.interactions },
            })
          },
        }),
      ],
    }),
  )
}
