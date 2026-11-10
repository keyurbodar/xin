import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { answer, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, rowState, toolTexts, turn } from "../../test/support.ts"

const PROMPT = {
  name: "hello",
  description: "Greet me with the hello tool.",
  text: "Greet me with the hello tool, then tell me which greeting the plugin is configured with.",
  source: { kind: "row", row: "hello" },
}

describe("hello", () => {
  it("adds its tool and its prompt once the plugin is on", async () => {
    const stub = fresh()
    const on = await cmd(stub, "hello-on", "plugin.enable", { id: "hello", enabled: true })
    expect(on.result).toMatchObject({ application: "applied" })
    expect(await rowState(stub, "hello")).toEqual({ kind: "active" })

    respond([
      fauxAssistantMessage([fauxToolCall("hello", { who: "world" })], { stopReason: "toolUse" }),
      answer("done"),
    ])
    await turn(stub, `hello-${crypto.randomUUID()}`)
    expect(await toolTexts(stub)).toEqual(["Hi, world!"])

    const prompts = await cmd(stub, "hello-prompts", "prompt.list")
    expect(prompts.result).toContainEqual(PROMPT)
  })
})
