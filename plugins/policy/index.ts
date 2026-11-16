import type { Context } from "../../src/kernel/index.ts"
import { createPolicy } from "./policy.ts"

export const name = "policy"
export const inject = ["harness", "ops", "pi", "kernel", "questions"]

export async function apply(ctx: Context): Promise<void> {
  const policy = createPolicy({
    harness: ctx.harness,
    questions: ctx.questions,
    registry: () => ctx.pi.registry.snapshot(),
    pluginOf: (extension) => {
      const row = ctx.pi.extensions().find((installed) => installed.name === extension)?.row
      return row === undefined ? undefined : ctx.kernel.pluginOfRow(row)
    },
  })
  for (const op of policy.ops) ctx.ops.define(op)
  ctx.pi.install(policy.extension)
  ctx.on("ops/before", (call, next) => policy.respond(call.command, call.actor, next))
  const observation = ctx.harness.observeCommits({
    advance: (publication) => {
      if (
        publication.changes.some(
          (change) => change.type === "document" && change.kind === "change" && change.record.kind === "xin.workspace",
        )
      )
        policy.realign()
    },
    end: () => undefined,
  })
  ctx.effect(() => () => observation.detach(), "policy.observe")
  await policy.start()
}
