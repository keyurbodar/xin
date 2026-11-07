import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, type OfferLog, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const FILES = ["read", "write", "edit"]
const ROW_ID = "preset-memory"

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { id: string; coordinatorId: number }
}

async function chooseModel(stub: Stub, coordinatorId: number): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M8_MODEL }, context)
  })
}

async function turn(stub: Stub, coordinatorId: number, offers: OfferLog): Promise<void> {
  respond([offers.step("noted")])
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.submit({ type: "input", content: "go", requestId: `preset-${crypto.randomUUID()}` }, context)
    await conversation.waitForIdle(context)
  })
}

async function insertPreset(stub: Stub, id: string, config: Record<string, unknown>): Promise<void> {
  const inserted = await cmd(stub, `insert-${id}`, "plugin.insert", { id, plugin: "preset", config })
  expect(inserted.result, JSON.stringify(inserted)).toMatchObject({ application: "applied" })
}

const memoryPreset = {
  title: "Memory only",
  description: "Notes and skills, no files.",
  tools: ["tool-memory", "tool-skills"],
}

describe("preset row", () => {
  it("lists and assigns a preset carried by a row, hiding the tool rows it does not allow", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "row-preset")
    await chooseModel(stub, project.coordinatorId)
    await insertPreset(stub, ROW_ID, memoryPreset)

    const listed = await cmd(stub, "list-row-preset", "preset.list")
    expect(listed.result).toMatchObject({
      presets: expect.arrayContaining([{ id: ROW_ID, ...memoryPreset }]),
    })

    const assigned = await cmd(stub, "assign-row-preset", "preset.assign", {
      projectId: project.id,
      preset: ROW_ID,
    })
    expect(assigned.result, JSON.stringify(assigned)).toMatchObject({ preset: { id: ROW_ID } })

    const offers = recordOffers()
    await turn(stub, project.coordinatorId, offers)

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("falls back to the default when the row is removed", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "row-removed")
    await chooseModel(stub, project.coordinatorId)
    await insertPreset(stub, ROW_ID, memoryPreset)
    await cmd(stub, "assign-row-removed", "preset.assign", { projectId: project.id, preset: ROW_ID })

    expect(await cmd(stub, "remove-row-preset", "plugin.remove", { id: ROW_ID })).toMatchObject({
      result: { application: "applied", id: ROW_ID },
    })

    expect((await cmd(stub, "list-row-removed", "preset.list")).result).toMatchObject({
      projects: [{ projectId: project.id, preset: "full" }],
    })

    const offers = recordOffers()
    await turn(stub, project.coordinatorId, offers)

    expect(offers.latest().tools).toEqual(expect.arrayContaining(FILES))
  }, 20_000)

  it("keeps the config preset when a row uses the same id", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "row-shadowed")
    await chooseModel(stub, project.coordinatorId)
    await insertPreset(stub, "row-minimal", {
      id: "minimal",
      title: "Row minimal",
      description: "This should lose to the config preset.",
      tools: "all",
    })

    const listed = await cmd(stub, "list-row-shadowed", "preset.list")
    expect(listed.result).toMatchObject({
      presets: expect.arrayContaining([
        {
          id: "minimal",
          title: "Minimal",
          description: "Memory and skills only.",
          tools: ["tool-memory", "tool-skills"],
        },
      ]),
    })

    await cmd(stub, "assign-row-shadowed", "preset.assign", { projectId: project.id, preset: "minimal" })
    const offers = recordOffers()
    await turn(stub, project.coordinatorId, offers)

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)
})
