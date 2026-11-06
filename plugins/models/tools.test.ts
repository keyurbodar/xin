import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  fauxAssistantMessage,
  getCurrentSystemMessage,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const requests: TranscriptContext[] = []

const record =
  (text: string): FauxResponseStep =>
  (request) => {
    requests.push(request)
    return fauxAssistantMessage(text)
  }

const offered = (index: number): readonly string[] => {
  const request = requests[index]
  if (request === undefined) throw new Error(`no request ${index} recorded`)
  return getCurrentSystemMessage(request.messages)?.toolsAdded?.map((tool) => tool.name) ?? []
}

type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const cmd = (stub: DurableObjectStub<Home>, id: string, op: string, args: unknown = {}) =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

async function turn(stub: DurableObjectStub<Home>, id: string, text: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(M8_MODEL)
    await home.submit(text, id)
    await home.harness.waitForIdle(context)
  })
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const rowState = async (stub: DurableObjectStub<Home>, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${id}`, "plugin.list")
  if (!Array.isArray(listed.result)) throw new Error("plugin.list did not return rows")
  return field(
    listed.result.find((row) => field(row, "id") === id),
    "state",
  )
}

describe("tool-models row", () => {
  it("offers set_model only while tool-models is active, and leaves the models service running", async () => {
    const stub = fresh()

    respond([record("first")])
    await turn(stub, "row-turn-1", "hello")
    expect(offered(0)).toContain("set_model")

    expect(await cmd(stub, "row-disable", "plugin.enable", { id: "tool-models", enabled: false })).toMatchObject({
      ok: true,
      result: { application: "applied", row: { state: { kind: "disabled" } } },
    })
    expect(await rowState(stub, "models")).toEqual({ kind: "active" })
    expect(await rowState(stub, "tool-models")).toEqual({ kind: "disabled" })
    expect(await cmd(stub, "row-default", "owner.defaults", { role: "chat", model: M8_MODEL })).toMatchObject({
      ok: true,
      result: { role: "chat", model: M8_MODEL },
    })
    expect((await cmd(stub, "row-list", "models.list", {})).ok).toBe(true)

    requests.length = 0
    respond([record("second")])
    await turn(stub, "row-turn-2", "what models are there")
    expect(offered(0)).not.toContain("set_model")

    expect(await cmd(stub, "row-enable", "plugin.enable", { id: "tool-models", enabled: true })).toMatchObject({
      ok: true,
      result: { application: "applied", row: { state: { kind: "active" } } },
    })

    requests.length = 0
    respond([record("third")])
    await turn(stub, "row-turn-3", "switch models")
    expect(offered(0)).toContain("set_model")
  }, 30_000)
})
