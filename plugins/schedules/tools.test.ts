import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>
type Ack = { readonly ok: boolean; readonly error?: unknown; readonly result?: unknown }

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const setRow = async (stub: Stub, id: string, enabled: boolean): Promise<void> => {
  const ack = await cmd(stub, `${id}-${enabled}-${crypto.randomUUID()}`, "plugin.enable", { id, enabled })
  expect(ack.result).toMatchObject({ application: "applied", row: { disabled: !enabled } })
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const rowOf = (result: unknown, id: string): unknown =>
  Array.isArray(result) ? result.find((row) => field(row, "id") === id) : undefined

let offered: readonly string[] = []

const offering =
  (reply = "ok"): FauxResponseStep =>
  (context) => {
    const tools = new Set<string>()
    for (const message of context.messages) {
      if (message.role !== "system") continue
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name)
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    }
    offered = [...tools]
    return fauxAssistantMessage(reply)
  }

async function turn(stub: Stub): Promise<readonly string[]> {
  respond([offering()])
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(M8_MODEL)
    await home.submit("go", `turn-${crypto.randomUUID()}`)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
  })
  return offered
}

describe("tool-schedules row", () => {
  it("offers the schedule tools only while its row is active and leaves the service running", async () => {
    const stub = fresh()

    const first = await turn(stub)
    expect(first).toEqual(expect.arrayContaining(["schedule", "unschedule"]))

    await setRow(stub, "tool-schedules", false)
    const rows = await cmd(stub, "list-off", "plugin.list")
    expect(rowOf(rows.result, "schedules")).toMatchObject({ disabled: false, state: { kind: "active" } })
    expect(rowOf(rows.result, "tool-schedules")).toMatchObject({ disabled: true, state: { kind: "disabled" } })

    const hidden = await turn(stub)
    expect(hidden).not.toContain("schedule")
    expect(hidden).not.toContain("unschedule")

    const at = Date.now() + 600_000
    const created = await cmd(stub, "create", "schedule.create", { id: "kept", at, tz: "UTC", prompt: "ping" })
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { id: "kept", created: true } })
    const listed = await cmd(stub, "list-live", "schedule.list")
    expect(JSON.stringify(listed.result)).toContain('"id":"kept"')

    await setRow(stub, "tool-schedules", true)
    const restored = await turn(stub)
    expect(restored).toEqual(expect.arrayContaining(["schedule", "unschedule"]))
    expect(rowOf((await cmd(stub, "list-on", "plugin.list")).result, "tool-schedules")).toMatchObject({
      disabled: false,
      state: { kind: "active" },
    })
  })
})
