import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonObject } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { PRODUCT_MODEL, type ProductHomeTest, respondProduct } from "./worker.ts"

/**
 * What a turn costs the model, measured from the requests the provider actually receives, on the shipped profile.
 *
 * A turn is scripted as `Move`s, one model request each, so the same turn costs the same bytes on every run. The
 * numbers are what a provider bills: `promptBytes` is every request's system prompt, tool declarations and history,
 * `freshBytes` the part a provider's prompt cache cannot reuse from the previous request, and `toolResultBytes` the
 * tool output that entered a prompt after the request that ran the tool.
 */

const encoder = new TextEncoder()
const size = (value: string): number => encoder.encode(value).length

type Stored = {
  readonly role: string
  readonly content?: unknown
  readonly toolCallId?: unknown
  readonly toolName?: unknown
  readonly isError?: unknown
}

export type SentMessage = { readonly role: string; readonly text: string }

/**
 * One message as the provider receives it. A provider adapter keeps a message's role and content and, for a tool
 * result, its call id, name and error flag; the `details` a UI reads, the usage and the timestamps stay behind
 * (pi-ai's `convertToolResult`). A system message is sent whole: its sections are the prompt and its tools the
 * declarations.
 */
function sent(message: Stored): SentMessage {
  if (message.role === "system") return { role: message.role, text: JSON.stringify(message) }
  const wire: Record<string, unknown> = { role: message.role, content: message.content }
  for (const key of ["toolCallId", "toolName", "isError"] as const)
    if (message[key] !== undefined) wire[key] = message[key]
  return { role: message.role, text: JSON.stringify(wire) }
}

export type ProductStub = DurableObjectStub<ProductHomeTest>

export const freshProduct = (): ProductStub => env.PRODUCT.get(env.PRODUCT.newUniqueId())

export type Ack = { readonly ok: boolean; readonly result?: unknown }

/** One owner command on the product home, as the client sends it. */
export const productCmd = (stub: ProductStub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

export type Move =
  | { readonly calls: readonly { readonly name: string; readonly args: JsonObject }[] }
  | { readonly answer: string }

export type RequestReading = {
  readonly promptBytes: number
  readonly freshBytes: number
  readonly toolCalls: number
  readonly toolResultBytes: number
  /** Bytes of the tool declarations, which every request carries. */
  readonly tools: number
  /** System messages in the request: one, unless a section changed after the prompt was written. */
  readonly systemEntries: number
}

export type TurnCost = {
  /** Model requests the run made. */
  readonly modelCalls: number
  /** Bytes of every request: system prompt, tool declarations and history. */
  readonly promptBytes: number
  /** The share of `promptBytes` the previous request did not already carry, so a cache cannot serve it. */
  readonly freshBytes: number
  /** Bytes of the tool declarations the first request carried. */
  readonly schemaBytes: number
  /** Bytes of the current system prompt text, replayed from its sections. */
  readonly sectionBytes: number
  /** Tool calls the run executed. */
  readonly toolCalls: number
  /** Tool result bytes that entered a prompt. */
  readonly toolResultBytes: number
  readonly wallMs: number
  /** Requests made, in order, for reading one turn's shape. */
  readonly requests: readonly RequestReading[]
  /** The last request's messages, to hand to the next turn as its `carry`. */
  readonly carry: readonly SentMessage[]
}

/** The index of the first message a request does not share with the one before it. */
function sharedCount(previous: readonly SentMessage[], next: readonly SentMessage[]): number {
  let index = 0
  while (index < Math.min(previous.length, next.length) && previous[index]?.text === next[index]?.text) index += 1
  return index
}

export type TurnOptions = {
  /** The owner message the turn starts from. */
  readonly text?: string
  /** Messages of the request before this turn, so a turn after another one sees its own share of the prompt. */
  readonly carry?: readonly SentMessage[]
}

/**
 * Script one turn on the shipped profile: each move becomes one faux response, and every request is measured before
 * it is answered. `text` is the owner message the turn starts from.
 */
export async function measureTurn(
  stub: ProductStub,
  requestId: string,
  moves: readonly Move[],
  options: TurnOptions = {},
): Promise<TurnCost> {
  const requests: RequestReading[] = []
  let previous: readonly SentMessage[] = options.carry ?? []
  let toolCalls = 0
  let toolResultBytes = 0
  let schemaBytes = 0
  let sectionBytes = 0

  const measure = (context: TranscriptContext, move: Move): void => {
    const messages = context.messages.map(sent)
    const fresh = messages.slice(sharedCount(previous, messages))
    const results = messages.filter((message) => message.role === "toolResult")
    const entered = results.slice(previous.filter((message) => message.role === "toolResult").length)
    const enteredBytes = entered.reduce((total, message) => total + size(message.text), 0)
    const calls = "calls" in move ? move.calls.length : 0
    const tools = getCurrentTools(context.messages)
    toolCalls += calls
    toolResultBytes += enteredBytes
    if (requests.length === 0) {
      schemaBytes = size(JSON.stringify(tools))
      sectionBytes = size(getCurrentSystemPrompt(context.messages))
    }
    requests.push({
      promptBytes: messages.reduce((total, message) => total + size(message.text), 0),
      freshBytes: fresh.reduce((total, message) => total + size(message.text), 0),
      toolCalls: calls,
      toolResultBytes: enteredBytes,
      tools: size(JSON.stringify(tools)),
      systemEntries: context.messages.filter((message) => message.role === "system").length,
    })
    previous = messages
  }

  const step =
    (move: Move): FauxResponseStep =>
    (context) => {
      measure(context, move)
      return "calls" in move
        ? fauxAssistantMessage(
            move.calls.map((call, index) =>
              fauxToolCall(call.name, call.args, { id: `${requestId}-${requests.length}-${index}` }),
            ),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(move.answer)
    }

  respondProduct(moves.map(step))
  const started = performance.now()
  await runInDurableObject(stub, async (home: ProductHomeTest) => {
    await home.chooseModel(PRODUCT_MODEL)
    await home.submit(options.text ?? "go", requestId)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
  })
  const wallMs = performance.now() - started

  return {
    modelCalls: requests.length,
    promptBytes: requests.reduce((total, request) => total + request.promptBytes, 0),
    freshBytes: requests.reduce((total, request) => total + request.freshBytes, 0),
    schemaBytes,
    sectionBytes,
    toolCalls,
    toolResultBytes,
    wallMs,
    requests,
    carry: previous,
  }
}
