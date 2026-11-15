import { defineDoc } from "@earendil-works/pi-durable"
import { bool, int, map, obj, opt, str, type Static } from "@earendil-works/pi-schema"

/** One Puck conversation. The conversation id is the map key, so a client can send to it directly. */
const PuckConversationSchema = obj({
  title: str({ minLength: 1, maxLength: 200 }),
  archived: bool(),
  createdAt: int({ minimum: 0 }),
  commandId: opt(str({ minLength: 1 })),
})

const PuckSchema = obj({ conversations: map(PuckConversationSchema) })

export type PuckConversation = Static<typeof PuckConversationSchema>
export type PuckState = Static<typeof PuckSchema>

export const PuckDoc = defineDoc<PuckState>({
  kind: "xin.puck",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
  checkpointWhen: () => false,
})
