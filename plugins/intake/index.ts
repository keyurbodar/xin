import { int, obj, opt, str } from "@earendil-works/pi-schema"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"
import type { IntakeBatch, IntakeBatchResult } from "../../src/contracts/intake.ts"
import { MessageSendArgsSchema } from "../../src/contracts/message.ts"
import { defineOp, OpRejected } from "../../src/ops.ts"
import { type BatchLedger, createGateway, enqueue, type IntakeHost, resolve, stop } from "./gateway.ts"
import { historyOp } from "./history.ts"

export const name = "intake"
export const inject = ["db", "harness", "ops", "clock", "host", "files", "models"]

const BATCH_MARK = "intake.dispatched."

type BatchListener = (batch: IntakeBatch, next: () => Promise<IntakeBatchResult>) => unknown

export async function apply(ctx: Context): Promise<void> {
  const host: IntakeHost = {
    db: ctx.db,
    harness: ctx.harness,
    ledger: ledgerOf(ctx),
    arm: (wake) => ctx.clock.arm(wake),
    push: () => ctx.get("push"),
    readBytes: (path) => ctx.files.readBytes(path),
    stat: (path) => ctx.files.stat(path),
    vision: async (conversation: ConversationId) => {
      const target = await ctx.harness.conversation(conversation, BACKGROUND_CONTEXT)
      const model = target === undefined ? undefined : (await target.agent(BACKGROUND_CONTEXT)).model
      return model === undefined ? false : ctx.models.vision(model)
    },
    batchEvent: (batch, next) => batchEvent(ctx, batch, next),
  }
  const gateway = createGateway(host)
  ctx.provide("intake", gateway.intake)
  ctx.ops.define(
    defineOp({
      name: "message.send",
      args: MessageSendArgsSchema,
      actors: ["owner"],
      run: async (api, args) => {
        if (args.text.trim() === "" && (args.attachments ?? []).length === 0)
          throw new OpRejected("bad_args", "a message needs text or a file")
        const target = await resolve(host, args.conv)
        const accepted = await enqueue(
          ctx.db,
          {
            target,
            commandId: api.commandId,
            kind: "user",
            text: args.text,
            attachments: args.attachments ?? [],
            ...(args.clientTs === undefined ? {} : { clientTs: args.clientTs }),
          },
          Date.now(),
        )
        if (accepted) await ctx.clock.arm()
        return { accepted }
      },
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "message.withdraw",
      args: obj({ commandId: str({ minLength: 1 }) }),
      actors: ["owner"],
      run: async (_api, args) => ({ withdrawn: await gateway.intake.withdraw(args.commandId) }),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "conv.stop",
      args: obj({ conv: opt(int({ minimum: 0 })) }),
      actors: ["owner"],
      run: async (_api, args) => {
        await stop(host, args.conv)
        return { stopped: true }
      },
    }),
  )
  ctx.ops.define(historyOp())
  ctx.on("wire/typing", async (conversation, on) => gateway.typing(conversation, on))
  ctx.clock.timer({ due: () => gateway.due(), fire: (now) => gateway.fire(now) })
  await gateway.start()
}

const markKey = (batchId: string): string => `${BATCH_MARK}${batchId}`

function ledgerOf(ctx: Context): BatchLedger {
  const kv = ctx.host.state.storage.kv
  return {
    processed: (batchId) => kv.get<boolean>(markKey(batchId)) === true,
    mark: (batchId) => kv.put(markKey(batchId), true),
    forget: (batchId) => {
      kv.delete(markKey(batchId))
    },
    ids: () => [...kv.list<boolean>({ prefix: BATCH_MARK })].map(([marked]) => marked.slice(BATCH_MARK.length)),
  }
}

async function batchEvent(
  ctx: Context,
  batch: IntakeBatch,
  next: () => Promise<IntakeBatchResult>,
): Promise<IntakeBatchResult> {
  const listeners: readonly BatchListener[] = ctx.events.dispatch("waterfall", ["intake/batch", batch, next])
  return contain(ctx, listeners, batch, next, 0)
}

function contain(
  ctx: Context,
  listeners: readonly BatchListener[],
  batch: IntakeBatch,
  last: () => Promise<IntakeBatchResult>,
  index: number,
): Promise<IntakeBatchResult> {
  const listener = listeners[index]
  if (listener === undefined) return last()
  let called = false
  let inner: Promise<IntakeBatchResult> | undefined
  const next = (): Promise<IntakeBatchResult> => {
    if (called) throw new Error("next() called multiple times")
    called = true
    inner = contain(ctx, listeners, batch, last, index + 1)
    return inner
  }
  return run(listener, batch, next).then(
    (value) => batchResult(value) ?? inner ?? next(),
    (error: unknown) => {
      ctx.logger.error(error)
      return inner ?? next()
    },
  )
}

async function run(
  listener: BatchListener,
  batch: IntakeBatch,
  next: () => Promise<IntakeBatchResult>,
): Promise<unknown> {
  return listener(batch, next)
}

function batchResult(value: unknown): IntakeBatchResult | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const kind: unknown = Reflect.get(value, "kind")
  if (kind === "dispatched") return { kind: "dispatched" }
  if (kind !== "dropped") return undefined
  const reason: unknown = Reflect.get(value, "reason")
  return typeof reason === "string" ? { kind: "dropped", reason } : undefined
}
