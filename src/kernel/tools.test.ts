import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}) =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<{ ok: boolean; result?: unknown }>())

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
  it("lets the agent read plugin rows but not change them until the owner allows it", async () => {
    const stub = fresh()
    respond([
      call("plugin_manager", { action: "list" }),
      call("plugin_manager", { action: "enable", id: "time", enabled: false }),
      fauxAssistantMessage("done"),
    ])
    const [listed, refused] = await turn(stub, "t1")
    expect(listed).toContain('"id": "time"')
    expect(refused).toContain("owner-only")
    expect(await cmd(stub, "g1", "plugin.list").then((ack) => JSON.stringify(ack.result))).toContain(
      '"id":"time","plugin":"time"',
    )

    const allowed = await cmd(stub, "allow", "plugin.configure", { id: "plugins", config: { allowAgent: true } })
    expect(allowed.result).toMatchObject({ application: "applied", row: { state: { kind: "active" } } })
    respond([call("plugin_manager", { action: "enable", id: "time", enabled: false }), fauxAssistantMessage("done")])
    const [changed] = await turn(stub, "t2")
    expect(changed).toContain('"application": "applied"')
    const rows = await cmd(stub, "g2", "plugin.list")
    const time = Array.isArray(rows.result) ? rows.result.find((row) => Reflect.get(row, "id") === "time") : undefined
    expect(time).toMatchObject({ disabled: true, state: { kind: "disabled" } })
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
