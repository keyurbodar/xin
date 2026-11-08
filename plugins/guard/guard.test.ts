import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type JsonObject } from "@earendil-works/pi-ai"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, field, fresh, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import manifest from "./package.json"
import * as guard from "./index.ts"

const context = BACKGROUND_CONTEXT
const GENTLE = "repeating the exact same tool call"
const DETAILED = "Repeated tool call detected"

type GuardConfig = {
  readonly thresholds?: number[]
  readonly include?: string[]
  readonly exclude?: string[]
  readonly argumentsPreviewChars?: number
}

type Result = { readonly text: string; readonly isError: boolean }

const call = (tool: string, args: JsonObject = {}): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" })

const answer = (text: string): FauxResponseStep => fauxAssistantMessage(text)

async function toolResults(home: Home): Promise<Result[]> {
  const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (message.role !== "toolResult") return []
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      return [{ text, isError: message.isError }]
    }),
  )
}

async function play(options: {
  readonly steps: readonly FauxResponseStep[]
  readonly config?: GuardConfig
  readonly turns?: readonly string[]
}): Promise<readonly Result[]> {
  const stub: Stub = fresh()
  if (options.config !== undefined) expect(await configure(stub, options.config)).toBe("loaded")
  respond(options.steps)
  return runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(M8_MODEL)
    for (const [index, text] of (options.turns ?? ["go"]).entries()) {
      await home.submit(text, `guard-${index}-${crypto.randomUUID()}`)
      await home.harness.waitForIdle(context)
    }
    return toolResults(home)
  })
}

const reminded = (results: readonly Result[]): boolean[] =>
  results.map((result) => result.text.includes(GENTLE) || result.text.includes(DETAILED))

async function configure(stub: Stub, config: GuardConfig): Promise<string> {
  const ack = await cmd(stub, `guard-config-${crypto.randomUUID()}`, "plugin.configure", { id: "guard", config })
  const applied = ack.result !== undefined && field(ack.result, "application") === "applied"
  return applied ? "loaded" : JSON.stringify(ack.result ?? ack.error ?? {})
}

async function load(config: GuardConfig): Promise<string> {
  return configure(fresh(), config)
}

describe("row", () => {
  it("declares one guard row and one bundle row pointing at it, with its defaults", () => {
    expect(manifest.xin.plugins.guard).toMatchObject({ module: "./index.ts" })
    expect(manifest.xin.bundle).toEqual([{ id: "guard", plugin: "guard" }])
    expect(guard.Config({})).toMatchObject({ thresholds: [3, 5, 8], include: [], exclude: [] })
    expect(guard.Config({})).toMatchObject({ argumentsPreviewChars: 500 })
  })

  it("installs its advisory extension beside the composed tree", async () => {
    const installed = await runInDurableObject(fresh(), (home: Home) => home.extension("xin.guard").hooks?.length)
    expect(installed).toBe(2)
  })
})

describe("reminders", () => {
  it("reminds gently at 3, in detail at 5 and 8, and leaves the tool's own output intact", async () => {
    const results = await play({
      steps: [...Array.from({ length: 8 }, () => call("recall", { q: "same" })), answer("done")],
    })

    expect(results).toHaveLength(8)
    expect(reminded(results)).toEqual([false, false, true, false, true, false, false, true])
    expect(results[2]?.text).toContain(GENTLE)
    expect(results[2]?.text).not.toContain(DETAILED)
    expect(results[2]?.text).toContain("No matching notes.")
    expect(results[4]?.text).toContain(DETAILED)
    expect(results[4]?.text).toContain("- tool: recall")
    expect(results[4]?.text).toContain("consecutive_calls: 5")
    expect(results[4]?.text).toContain('- arguments: {"q":"same"}')
    expect(results[7]?.text).toContain("consecutive_calls: 8")
    expect(results[7]?.text).toContain('- arguments: {"q":"same"}')
  })

  it("stays silent when the arguments change between calls", async () => {
    const results = await play({
      steps: [
        call("recall", { q: "a" }),
        call("recall", { q: "b" }),
        call("recall", { q: "a" }),
        call("recall", { q: "b" }),
        call("recall", { q: "a" }),
        answer("done"),
      ],
    })

    expect(results).toHaveLength(5)
    expect(reminded(results).some(Boolean)).toBe(false)
  })

  it("treats the same tool with different key order as identical", async () => {
    const results = await play({
      steps: [
        call("recall", { q: "x", scope: "me" }),
        call("recall", { scope: "me", q: "x" }),
        call("recall", { q: "x", scope: "me" }),
        answer("done"),
      ],
    })

    expect(reminded(results)).toEqual([false, false, true])
  })

  it("treats a different tracked call as a reset", async () => {
    const results = await play({
      steps: [
        call("recall", { q: "a" }),
        call("recall", { q: "a" }),
        call("ping"),
        call("recall", { q: "a" }),
        call("recall", { q: "a" }),
        call("recall", { q: "a" }),
        answer("done"),
      ],
    })

    expect(reminded(results)).toEqual([false, false, false, false, false, true])
  })

  it("caps the quoted arguments at argumentsPreviewChars without losing the match", async () => {
    const long = "x".repeat(40)
    const results = await play({
      config: { thresholds: [2, 3], argumentsPreviewChars: 24 },
      steps: [call("recall", { q: long }), call("recall", { q: long }), call("recall", { q: long }), answer("done")],
    })

    expect(reminded(results)).toEqual([false, true, true])
    expect(results[1]?.text).toContain(GENTLE)
    expect(results[2]?.text).toContain('- arguments: {"q":"xxxxxxxxxxxxxxxxxx… (+24 more chars)')
    expect(results[2]?.text).not.toContain(long)
  })

  it("clears the count when a new owner message arrives", async () => {
    const results = await play({
      config: { thresholds: [3] },
      turns: ["go", "again"],
      steps: [
        call("recall", { q: "a" }),
        call("recall", { q: "a" }),
        answer("first"),
        call("recall", { q: "a" }),
        answer("second"),
      ],
    })

    expect(results).toHaveLength(3)
    expect(reminded(results).some(Boolean)).toBe(false)
  })

  it("never counts or resets an excluded tool", async () => {
    const results = await play({
      config: { thresholds: [3], exclude: ["ping"] },
      steps: [
        call("recall", { q: "a" }),
        call("ping"),
        call("recall", { q: "a" }),
        call("ping"),
        call("recall", { q: "a" }),
        answer("done"),
      ],
    })

    expect(reminded(results)).toEqual([false, false, false, false, true])
  })

  it("tracks only included tools", async () => {
    const results = await play({
      config: { thresholds: [3], include: ["recall"] },
      steps: [call("ping"), call("ping"), call("ping"), call("ping"), answer("done")],
    })

    expect(results).toHaveLength(4)
    expect(reminded(results).some(Boolean)).toBe(false)
  })

  it("counts an error result and appends the reminder to it", async () => {
    const results = await play({
      config: { thresholds: [3] },
      steps: [
        call("recall", { q: "x", scope: "project:elsewhere" }),
        call("recall", { q: "x", scope: "project:elsewhere" }),
        call("recall", { q: "x", scope: "project:elsewhere" }),
        answer("done"),
      ],
    })

    expect(results).toHaveLength(3)
    expect(results.every((result) => result.isError)).toBe(true)
    expect(reminded(results)).toEqual([false, false, true])
    expect(results[2]?.text).toContain("Cannot recall:")
    expect(results[2]?.text).toContain(GENTLE)
  })
})

describe("config", () => {
  it("rejects an empty thresholds list", async () => {
    expect(await load({ thresholds: [] })).toContain("must not be empty")
  })

  it("rejects a threshold below 2 or a fractional one", async () => {
    expect(await load({ thresholds: [1, 3] })).toContain("integer >= 2")
    expect(await load({ thresholds: [2.5] })).toContain("integer >= 2")
  })

  it("rejects duplicate thresholds", async () => {
    expect(await load({ thresholds: [3, 3] })).toContain("must not contain duplicates")
  })

  it("rejects an arguments preview below one character", async () => {
    expect(await load({ argumentsPreviewChars: 0 })).toContain("argumentsPreviewChars")
    expect(await load({ argumentsPreviewChars: 12.5 })).toContain("argumentsPreviewChars")
  })
})
