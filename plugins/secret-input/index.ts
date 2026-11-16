import type { Context } from "../../src/kernel/index.ts"
import { provideOp } from "./secret.ts"

export const name = "secret-input"
export const inject = ["ops", "questions", "secrets"]

export function apply(ctx: Context): void {
  ctx.ops.define(provideOp({ questions: ctx.questions, set: (ref, value) => ctx.secrets.set(ref, value) }))
}
