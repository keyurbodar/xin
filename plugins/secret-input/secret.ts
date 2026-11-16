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
 * `ops/before` listeners. The value is written inside the answer's commit, after every check the answer passes, so a
 * refused answer stores nothing; a request is claimed before the first await, so of two concurrent provides one runs
 * and the other is refused as busy.
 */
export function provideOp(port: SecretPort): Op {
  const claimed = new Set<string>()
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
      const claim = `${args.threadId}:${args.requestId}`
      if (claimed.has(claim)) throw new OpRejected("busy", `secret request ${args.requestId} is being answered`)
      claimed.add(claim)
      try {
        const threadId = args.threadId as ConversationId
        const requests = await api.harness.snapshot(RequestsDoc, threadId, BACKGROUND_CONTEXT)
        const settled = requests?.answered[args.requestId]
        if (settled !== undefined)
          return {
            threadId: args.threadId,
            requestId: args.requestId,
            kind: "already_answered",
            answer: settled.answer,
          }
        const open = requests?.open[args.requestId]
        const subject = open?.subject
        if (open?.kind !== SECRET_KIND || subject === undefined)
          throw new OpRejected("bad_args", `no open secret request ${args.requestId}`)
        const { value } = args
        const outcome = await port.questions.settle(
          threadId,
          args.requestId,
          value === undefined ? DECLINED : `stored as ${subject}`,
          async (admitted) => {
            if (admitted.kind !== SECRET_KIND || admitted.subject !== subject)
              throw new OpRejected("bad_args", `no open secret request ${args.requestId}`)
            if (value !== undefined) await port.set(subject, value)
          },
        )
        return { threadId: args.threadId, requestId: args.requestId, ...outcome }
      } finally {
        claimed.delete(claim)
      }
    },
  })
}
