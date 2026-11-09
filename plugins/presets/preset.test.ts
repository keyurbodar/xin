import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, rowState, type OfferLog, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const FILES = ["read", "write", "edit"]

type PresetRow = { readonly id: string; readonly plugin: string; readonly config: Record<string, unknown> }

async function put(stub: Stub, packageName: string, rows: readonly PresetRow[]): Promise<unknown> {
  const result = await cmd(stub, `put-${crypto.randomUUID()}`, "bundle.put", { package: packageName, rows })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  return result.result
}

async function makeProject(stub: Stub, preset: string): Promise<{ coordinatorId: number }> {
  const created = await cmd(stub, `create-${crypto.randomUUID()}`, "project.create", {
    slug: `row-${crypto.randomUUID().slice(0, 8)}`,
    name: "Row preset",
    preset,
  })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { coordinatorId: number }
}

async function turn(stub: Stub, coordinatorId: number, offers: OfferLog): Promise<void> {
  respond([offers.step("noted")])
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M8_MODEL }, context)
    await conversation.submit({ type: "input", content: "go", requestId: `preset-${crypto.randomUUID()}` }, context)
    await conversation.waitForIdle(context)
  })
}

describe("preset row", () => {
  it("publishes its identity and display fields through preset.list", async () => {
    const stub = fresh()
    const solo: PresetRow = {
      id: "preset-row-solo",
      plugin: "preset",
      config: { id: "solo", name: "Solo", description: "Memory only.", order: 5, plugins: ["tool-memory"] },
    }
    expect(await put(stub, "xin-plugin-preset-solo", [solo])).toMatchObject({ application: "applied" })

    const listed = await cmd(stub, `list-${crypto.randomUUID()}`, "preset.list")
    expect(listed.result, JSON.stringify(listed)).toMatchObject({
      presets: expect.arrayContaining([
        expect.objectContaining({
          id: "solo",
          name: "Solo",
          description: "Memory only.",
          order: 5,
          plugins: ["tool-memory"],
        }),
      ]),
    })
  }, 20_000)

  it("leaves the later row failed when two rows declare one id", async () => {
    const stub = fresh()
    const result = await put(stub, "xin-plugin-preset-dupe", [
      { id: "preset-row-first", plugin: "preset", config: { id: "dupe", plugins: "all" } },
      { id: "preset-row-second", plugin: "preset", config: { id: "dupe", plugins: "all" } },
    ])
    expect(result, JSON.stringify(result)).toMatchObject({
      application: "failed",
      rows: [{ id: "preset-row-second" }],
    })
    expect(await rowState(stub, "preset-row-first")).toMatchObject({ kind: "active" })
    expect(await rowState(stub, "preset-row-second")).toMatchObject({ kind: "failed" })
  }, 20_000)

  it("applies the tool allowlist a row declares", async () => {
    const stub = fresh()
    await put(stub, "xin-plugin-preset-memory", [
      {
        id: "preset-row-memory",
        plugin: "preset",
        config: { id: "memory-only", name: "Memory only", plugins: ["tool-memory"] },
      },
    ])
    const project = await makeProject(stub, "memory-only")
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, offers)

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)
})
