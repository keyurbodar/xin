import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type FauxResponseStep } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>

type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string }
}

const context = BACKGROUND_CONTEXT
const MEMORY_TOOLS = ["remember", "recall"]
const NOTE = { scope: "me", text: "The owner's dog is named Miso" }

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const rowOf = async (stub: Stub, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${crypto.randomUUID()}`, "plugin.list")
  return Array.isArray(listed.result) ? listed.result.find((row) => field(row, "id") === id) : undefined
}

const offers: string[][] = []

const offer =
  (reply: string): FauxResponseStep =>
  (request) => {
    offers.push(getCurrentTools(request.messages).map((tool) => tool.name))
    return fauxAssistantMessage(reply)
  }

const call = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

async function turn(stub: Stub, requestId: string): Promise<readonly string[]> {
  const before = offers.length
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(M8_MODEL)
    await home.submit("go", requestId)
    await home.harness.waitForIdle(context)
  })
  const last = offers.slice(before).at(-1)
  if (last === undefined) throw new Error("the faux model was not called")
  return last
}

describe("memory tool row", () => {
  it("offers the memory tools while both rows are active", async () => {
    const stub = fresh()
    respond([offer("ok")])
    const offered = await turn(stub, "p3-memory-active")
    for (const name of MEMORY_TOOLS) expect(offered).toContain(name)
  })

  it("removes exactly the memory tools when only the tool row is disabled, and restores them", async () => {
    const stub = fresh()

    respond([call("remember", { ...NOTE }), offer("noted")])
    await turn(stub, "p3-memory-remember")
    expect((await cmd(stub, "p3-memory-list-1", "memory.list")).result).toMatchObject({ notes: [NOTE] })

    const disabled = await cmd(stub, "p3-memory-disable", "plugin.enable", { id: "tool-memory", enabled: false })
    expect(disabled.result).toMatchObject({ application: "applied" })
    expect(field(await rowOf(stub, "tool-memory"), "state")).toEqual({ kind: "disabled" })
    expect(field(await rowOf(stub, "memory"), "state")).toEqual({ kind: "active" })

    respond([offer("ok")])
    const without = await turn(stub, "p3-memory-off")
    for (const name of MEMORY_TOOLS) expect(without).not.toContain(name)
    expect(without).toContain("current_time")

    expect((await cmd(stub, "p3-memory-list-2", "memory.list")).result).toMatchObject({ notes: [NOTE] })

    const enabled = await cmd(stub, "p3-memory-enable", "plugin.enable", { id: "tool-memory", enabled: true })
    expect(enabled.result).toMatchObject({ application: "applied" })
    respond([offer("ok")])
    const restored = await turn(stub, "p3-memory-on")
    for (const name of MEMORY_TOOLS) expect(restored).toContain(name)
  })
})
