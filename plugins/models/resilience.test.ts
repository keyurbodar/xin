import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { eventually, fresh } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { needsRetry, TRANSIENT_PREFIX } from "./resilience.ts"

const context = BACKGROUND_CONTEXT
const live = async (home: Home) => home.harness.snapshot(LiveDoc, (await home.root()).id as ConversationId, context)
const failed = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage })

describe("provider retries", () => {
  it("retries malformed responses and gateway statuses pi-ai treats as final", () => {
    for (const text of [
      "Could not parse Anthropic SSE event content_block_delta: Unexpected token",
      "Invalid Mistral streaming event",
      "Unexpected end of JSON input",
      "Unexpected token < in JSON at position 0",
      "Invalid response from upstream",
      "OpenAI Responses stream completed with an unfinished tool call: edit (call_1)",
      '529 {"type":"error"}',
      "HTTP 408",
    ])
      expect(needsRetry(failed(text)), text).toBe(true)
  })

  it("leaves alone what pi-ai already retries, request faults, quota and context overflow", () => {
    for (const text of [
      "503 Service Unavailable",
      "provider exploded",
      "400 invalid_request_error: messages.0.content is required",
      "401 Unauthorized",
      "insufficient_quota: invalid response",
      "prompt is too long: 250000 tokens > 200000 maximum",
      "400 invalid_request_error: malformed tool_use block",
      "400 Bad Request: request body is malformed JSON",
      "400 Invalid response_format: json_schema is required",
      "400 invalid_request_error: max_tokens: 529 is not a valid value",
      "401 Unauthorized: invalid response from auth service",
      "404 Not Found: body is not valid json",
      "Your credit balance is too low. invalid response",
    ])
      expect(needsRetry(failed(text)), text).toBe(false)
    expect(needsRetry(fauxAssistantMessage("Invalid response"))).toBe(false)
  })

  it("puts a malformed response on the durable backoff instead of failing the run", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["error:Could not parse Anthropic SSE event message_delta: Unexpected end of JSON input"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("hello", "retry-malformed")
    })
    await eventually(stub, async (home: Home) => (await live(home))?.generation?.retry !== undefined)
    const state = await runInDurableObject(stub, live)
    expect(state?.runFailure).toBeUndefined()
    expect(state?.generation?.retry?.error).toBe(
      `${TRANSIENT_PREFIX}Could not parse Anthropic SSE event message_delta: Unexpected end of JSON input`,
    )
  })

  it("still fails the run at once on an error that is not transient", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["error:provider exploded"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("hello", "retry-final")
    })
    await eventually(stub, async (home: Home) => (await live(home))?.runFailure !== undefined)
    expect((await runInDurableObject(stub, live))?.runFailure).toMatchObject({
      reason: "model_error",
      detail: "provider exploded",
    })
  })
})
