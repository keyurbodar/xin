import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import { type QuestionsService, RequestsDoc } from "../../src/contracts/questions.ts"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"

export const SECRET_KIND = "request_secret"
const DECLINED = "declined"

export type SecretPort = {
  readonly questions: Pick<QuestionsService, "settle">
  set(ref: string, value: string): Promise<void>
}

/**
 * The one path a secret card's value takes: into the secret store, never into the request, the answer or the run it
 * starts. The model's next run reads only "stored as <name>" or "declined"; `credentials` keeps `value` from
 * `ops/before` listeners.
 */
export function provideOp(port: SecretPort): Op {
  return defineOp({
    name: "secret.provide",
    args: obj({
      threadId: int({ minimum: 0 }),
      requestId: str({ minLength: 1 }),
      value: opt(str({ minLength: 1, maxLength: 8_000 })),
    }),
    actors: ["owner"],
    credentials: ["value"],
    run: async (api, args) => {
      const threadId = args.threadId as ConversationId
      const requests = await api.harness.snapshot(RequestsDoc, threadId, BACKGROUND_CONTEXT)
      const settled = requests?.answered[args.requestId]
      if (settled !== undefined)
        return { threadId: args.threadId, requestId: args.requestId, kind: "already_answered", answer: settled.answer }
      const open = requests?.open[args.requestId]
      if (open?.kind !== SECRET_KIND || open.subject === undefined)
        throw new OpRejected("bad_args", `no open secret request ${args.requestId}`)
      if (args.value !== undefined) await port.set(open.subject, args.value)
      const answer = args.value === undefined ? DECLINED : `stored as ${open.subject}`
      const outcome = await port.questions.settle(threadId, args.requestId, answer)
      return { threadId: args.threadId, requestId: args.requestId, ...outcome }
    },
  })
}
