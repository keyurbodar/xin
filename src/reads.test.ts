import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { READS } from "../web/src/lib/reads.ts"
import { respond } from "../test/plugins/m8.ts"
import { api, fresh, OWNER_HEADERS, turn } from "../test/support.ts"
import { MAX_BATCH } from "./kernel/wire.ts"

const post = (body: unknown) => api("/v1/cmd", { method: "POST", body: JSON.stringify(body) })

describe("reads the home declares", () => {
  it("declares every op the web client treats as a read, so none of them announces a change", async () => {
    const ops = Object.keys(READS)
    for (let start = 0; start < ops.length; start += MAX_BATCH) {
      const frames = ops
        .slice(start, start + MAX_BATCH)
        .map((op) => ({ id: `read-${crypto.randomUUID()}`, op, args: {} }))
      const reply = await post(frames)
      expect({ ops: frames.map((frame) => frame.op), rev: reply.headers.get("x-ingle-rev") }).toEqual({
        ops: frames.map((frame) => frame.op),
        rev: null,
      })
    }
  })
})

describe("agent writes the read cache cannot see coming", () => {
  it("moves the home revision on when the agent remembers a note, so tabs drop their cached memory reads", async () => {
    const stub = fresh()
    const bump = async (): Promise<string> => {
      const reply = await stub.fetch(
        new Request("https://ingle.test/v1/cmd", {
          method: "POST",
          headers: { ...OWNER_HEADERS, "content-type": "application/json" },
          body: JSON.stringify({ id: `bump-${crypto.randomUUID()}`, op: "test.bump", args: { by: 1 } }),
        }),
      )
      return String(reply.headers.get("x-ingle-rev"))
    }
    const [epoch, before] = (await bump()).split(".")
    respond([
      fauxAssistantMessage(
        [fauxToolCall("remember", { scope: "me", text: "The owner reads before bed" }, { id: "remember-1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("noted"),
    ])
    await turn(stub, "reads-remember")
    expect(await bump()).toBe(`${epoch}.${Number(before) + 2}`)
  })
})
