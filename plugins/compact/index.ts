import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  CompactionTask,
  type ConversationId,
  defineExtension,
  type Harness,
  hook,
  LiveDoc,
} from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import { type Context, defineOp, OpRejected } from "../../src/kernel/index.ts"
import { beforeCompact } from "./summary.ts"

export const name = "compact"
export const inject = ["ops", "pi", "models", "harness"]

const context = BACKGROUND_CONTEXT
const INSTRUCTIONS_LIMIT = 2000

const CompactArgs = obj({
  conversationId: int({ minimum: 0 }),
  instructions: opt(str({ minLength: 1, maxLength: INSTRUCTIONS_LIMIT })),
})

async function hasLiveWork(harness: Harness, id: ConversationId): Promise<boolean> {
  const live = await harness.snapshot(LiveDoc, id, context)
  return live?.run !== undefined || (live?.compactions?.length ?? 0) > 0
}

const compact = defineOp({
  name: "conv.compact",
  args: CompactArgs,
  actors: ["owner"],
  run: async (api, args) => {
    const conversation = await api.harness.conversation(args.conversationId as ConversationId, context)
    if (conversation === undefined) throw new OpRejected("bad_args", `no conversation ${args.conversationId}`)
    if (await hasLiveWork(api.harness, conversation.id))
      throw new OpRejected("busy", `conversation ${conversation.id} has a live run or compaction`)
    return { compaction: await conversation.compact(args.instructions, context) }
  },
})

export function apply(ctx: Context): void {
  ctx.ops.define(compact)
  ctx.pi.install(
    defineExtension({
      name: "xin.compact",
      hooks: [
        hook(CompactionTask, {
          beforeCompact: beforeCompact({
            ownerDefaults: () => ctx.models.ownerDefaults(),
            admit: () => ctx.models.admit("compaction"),
            charge: (conversation, message) => ctx.models.charge("compaction", conversation, message),
          }),
        }),
      ],
    }),
  )
}
