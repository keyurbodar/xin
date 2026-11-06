import type { JsonValue } from "@earendil-works/chord"
import type { ToolControl, ToolExecutionResult } from "@earendil-works/pi-durable"
import "./types.ts"

export type { Context, Plugin } from "@deepseek-ai/cordis"
export { default as Schema } from "@deepseek-ai/schemastery"
export { defineOp, OpRejected, type Actor, type Command, type Op, type Outcome } from "../ops.ts"
export type { Row } from "./layers.ts"
export { hostModule } from "./hostmodule.ts"
export type { HostModule, ModuleDeps, Provider, Route } from "../module.ts"
export type { OpCall } from "./types.ts"

export function textResult(
  text: string,
  extra: { readonly isError?: boolean; readonly details?: JsonValue; readonly control?: ToolControl } = {},
): ToolExecutionResult {
  return {
    output: [{ type: "text", text }],
    ...(extra.details === undefined ? {} : { details: extra.details }),
    ...(extra.isError === true ? { isError: true } : {}),
    ...(extra.control === undefined ? {} : { control: extra.control }),
  }
}
