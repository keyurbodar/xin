import type { Message } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { compile, int, obj, opt, type Static, str } from "@earendil-works/pi-schema"

export const MessageSendArgsSchema = obj({
  conv: opt(int({ minimum: 0 })),
  text: str({ minLength: 1 }),
  clientTs: opt(int({ minimum: 0 })),
})

export type MessageSendArgs = Static<typeof MessageSendArgsSchema>

const SEND = compile(MessageSendArgsSchema)

export type MessageTarget =
  | { readonly kind: "conversation"; readonly conversation: ConversationId }
  | { readonly kind: "root" }

export function messageSendTarget(args: unknown): MessageTarget | undefined {
  if (!SEND.check(args)) return undefined
  return args.conv === undefined
    ? { kind: "root" }
    : { kind: "conversation", conversation: args.conv as ConversationId }
}

export const CLOCK_READING_PREFIX = "Time sampled while preparing turn "

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const isClockReading = (message: Message): boolean =>
  message.role === "user" && textOf(message.content).startsWith(CLOCK_READING_PREFIX)

/** The newest message the model can see: the last one that is not a system message. */
export function newestVisible(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role !== "system") return message
  }
  return undefined
}

/**
 * The newest message that states an instruction: the last user message, when no assistant or tool message
 * follows it. The request-scoped clock reading the time row appends is not an instruction.
 */
export function newestInstruction(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role === "system" || isClockReading(message)) continue
    return message.role === "user" ? message : undefined
  }
  return undefined
}
