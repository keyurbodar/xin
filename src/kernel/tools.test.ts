import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

async function turn(stub: Stub, requestId: string): Promise<string[]> {
  return runInDurableObject(stub, async (home: Home) => {
    const before = (await results(home)).length
    await home.chooseModel(M8_MODEL)
    await home.submit("go", requestId)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    return (await results(home)).slice(before)
  })
}

async function results(home: Home): Promise<string[]> {
  {
    const page = await (await home.root()).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)
    return page.items.flatMap((entry: EntryRecord) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult" && Array.isArray(message.content)
          ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      ),
    )
  }
}

describe("plugin tools", () => {
  it("keeps the plugin_manager tool off until its row is enabled, then lets the agent read and change rows", async () => {
    const stub = fresh()
    await cmd(stub, "on", "plugin.enable", { id: "tool-plugins", enabled: true })

    respond([
      call("plugin_manager", { action: "list" }),
      call("plugin_manager", { action: "enable", id: "time", enabled: false }),
      fauxAssistantMessage("done"),
    ])
    const [listed, changed] = await turn(stub, "t1")
    expect(listed).toContain('"id": "time"')
    expect(changed).toContain('"application": "applied"')
    const rows = await cmd(stub, "g1", "plugin.list")
    const time = Array.isArray(rows.result) ? rows.result.find((row) => Reflect.get(row, "id") === "time") : undefined
    expect(time).toMatchObject({ disabled: true, state: { kind: "disabled" } })
  })

  it("returns a rejected change as a tool error", async () => {
    const stub = fresh()
    await cmd(stub, "on", "plugin.enable", { id: "tool-plugins", enabled: true })
    respond([call("plugin_manager", { action: "enable", id: "pi", enabled: false }), fauxAssistantMessage("done")])
    const [refused] = await turn(stub, "t2")
    expect(refused).toContain("bad_args")
    expect(refused).toContain("required")
  })

  it("runs the out-of-tree time plugin, reconfigures it, and fails a bad timezone without touching other rows", async () => {
    const stub = fresh()
    respond([call("current_time", {}), fauxAssistantMessage("done")])
    const [utc] = await turn(stub, "c1")
    expect(utc).toContain("(UTC, ")

    await cmd(stub, "tz1", "plugin.configure", { id: "time", config: { timezone: "Asia/Kolkata" } })
    respond([call("current_time", {}), fauxAssistantMessage("done")])
    const [kolkata] = await turn(stub, "c2")
    expect(kolkata).toContain("(Asia/Kolkata, ")

    const bad = await cmd(stub, "tz2", "plugin.configure", { id: "time", config: { timezone: "Mars/Olympus" } })
    expect(bad.result).toMatchObject({ application: "failed", row: { state: { kind: "failed" } } })
    expect(JSON.stringify(bad.result ?? bad)).toMatch(/time ?zone/i)
    const rows = await cmd(stub, "tz3", "plugin.list")
    const time = Array.isArray(rows.result) ? rows.result.find((row) => Reflect.get(row, "id") === "time") : undefined
    expect(time).toMatchObject({ state: { kind: "failed" } })
    expect(await cmd(stub, "b1", "test.bump")).toMatchObject({ ok: true, result: 1 })
  })
})
