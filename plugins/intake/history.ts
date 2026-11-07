import type { JsonValue } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, EntryId } from "@earendil-works/pi-durable"
import { int, obj, opt } from "@earendil-works/pi-schema"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"
import { SNAPSHOT_ENTRIES } from "../../src/wire.ts"

const context = BACKGROUND_CONTEXT
const MAX_PAGE = 200

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value))

export function historyOp(): Op {
  return defineOp({
    name: "history.page",
    args: obj({
      conversationId: int({ minimum: 0 }),
      before: opt(int({ minimum: 0 })),
      limit: opt(int({ minimum: 1, maximum: MAX_PAGE })),
    }),
    actors: ["owner"],
    run: async (api, args) => {
      const conversation = await api.harness.conversation(args.conversationId as ConversationId, context)
      if (conversation === undefined) throw new OpRejected("bad_args", `no conversation ${args.conversationId}`)
      if (args.before === 0) return { entries: [] }
      const page = await conversation.entries(
        {
          order: "descending",
          ...(args.before === undefined ? {} : { maxEntryId: (args.before - 1) as EntryId }),
        },
        args.limit ?? SNAPSHOT_ENTRIES,
        undefined,
        context,
      )
      const entries = page.items.toReversed()
      const oldest = entries[0]
      return {
        entries: toJson(entries),
        ...(page.next === undefined || oldest === undefined ? {} : { nextBefore: oldest.id }),
      }
    },
  })
}
