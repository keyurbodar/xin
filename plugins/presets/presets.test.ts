import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, type OfferLog, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const FILES = ["read", "write", "edit"]
const THREAD_PROMPT = "You are a thread named"
const PACKAGE = "xin-plugin-presets-test"
const MINIMAL: readonly string[] = ["tool-memory", "tool-skills"]

type PresetRow = { readonly id: string; readonly plugin: string; readonly config?: Record<string, unknown> }

const rows = (plugins: "all" | readonly string[] = MINIMAL): readonly PresetRow[] => [
  { id: "preset-row-all", plugin: "preset", config: { id: "test-all", name: "Test all", plugins: "all", order: 1 } },
  {
    id: "preset-row-minimal",
    plugin: "preset",
    config: { id: "test-minimal", name: "Test minimal", description: "Memory and skills only.", plugins, order: 2 },
  },
]

async function install(stub: Stub, presetRows: readonly PresetRow[]): Promise<void> {
  const put = await cmd(stub, `install-${crypto.randomUUID()}`, "bundle.put", {
    package: PACKAGE,
    rows: presetRows,
  })
  expect(put.result, JSON.stringify(put)).toMatchObject({ application: "applied" })
}

async function makeProject(stub: Stub, slug: string, preset?: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${crypto.randomUUID()}`, "project.create", {
    slug,
    name: slug,
    ...(preset === undefined ? {} : { preset }),
  })
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

async function turn(
  stub: Stub,
  coordinatorId: number,
  text: string,
  steps: readonly FauxResponseStep[],
): Promise<void> {
  respond([...steps])
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.submit({ type: "input", content: text, requestId: `presets-${crypto.randomUUID()}` }, context)
    await conversation.waitForIdle(context)
  })
}

const coordinatorStep = (offers: OfferLog): FauxResponseStep => offers.wrap(() => fauxAssistantMessage("noted"))

const threadStep = (offers: OfferLog): FauxResponseStep => offers.wrap(() => fauxAssistantMessage("thread answer"))

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition not reached")
}

async function delegateThread(stub: Stub, coordinatorId: number, offers: OfferLog): Promise<void> {
  respond([threadStep(offers), threadStep(offers), threadStep(offers), threadStep(offers)])
  await runInDurableObject(stub, async (home: Home) => {
    const outcome = await home.loader.ctx.threads.delegate(
      { conversationId: coordinatorId as ConversationId, taskId: "presets-test" },
      {
        task: "check the tools",
        title: "Tools",
        mode: "async",
        clientRequestId: `thread-${crypto.randomUUID()}`,
      },
      context,
    )
    expect(outcome.kind, JSON.stringify(outcome)).toBe("started")
  })
  await until(() => offers.seen.some((offer) => offer.system.includes(THREAD_PROMPT)))
}

const threadOffer = (offers: OfferLog) => offers.seen.find((offer) => offer.system.includes(THREAD_PROMPT))

describe("presets", () => {
  it("ships the full and minimal presets active", async () => {
    const stub = fresh()
    const listed = await cmd(stub, `list-${crypto.randomUUID()}`, "preset.list")
    expect(listed.result, JSON.stringify(listed)).toMatchObject({
      presets: expect.arrayContaining([
        expect.objectContaining({ id: "full", name: "Full", plugins: "all" }),
        expect.objectContaining({ id: "minimal", name: "Minimal", plugins: ["tool-memory", "tool-skills"] }),
      ]),
    })
  }, 20_000)

  it("keeps or drops a plugin's contributed skill and prompt with the preset", async () => {
    const stub = fresh()
    await install(stub, [
      { id: "contrib", plugin: "contrib" },
      {
        id: "preset-row-with-contrib",
        plugin: "preset",
        config: { id: "with-contrib", name: "With contributions", plugins: ["tool-skills", "contrib"] },
      },
      {
        id: "preset-row-without-contrib",
        plugin: "preset",
        config: { id: "without-contrib", name: "Without contributions", plugins: ["tool-skills"] },
      },
    ])

    const withContrib = await makeProject(stub, "with-contrib", "with-contrib")
    await chooseModel(stub, withContrib.coordinatorId)
    const shown = recordOffers()
    await turn(stub, withContrib.coordinatorId, "go", [coordinatorStep(shown)])
    expect(shown.latest().system).toContain("A contributed skill.")

    const without = await makeProject(stub, "without-contrib", "without-contrib")
    await chooseModel(stub, without.coordinatorId)
    const hidden = recordOffers()
    await turn(stub, without.coordinatorId, "go", [coordinatorStep(hidden)])
    expect(hidden.latest().system).not.toContain("A contributed skill.")

    const listed = await cmd(stub, `prompts-${crypto.randomUUID()}`, "prompt.list", {
      conversation: withContrib.coordinatorId,
    })
    expect(listed.result, JSON.stringify(listed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "contrib-prompt",
          description: "A contributed prompt.",
          text: "Contributed prompt text.",
          source: { kind: "row", row: "contrib" },
        }),
      ]),
    )
    const omitted = await cmd(stub, `prompts-${crypto.randomUUID()}`, "prompt.list", {
      conversation: without.coordinatorId,
    })
    expect(omitted.result, JSON.stringify(omitted)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "contrib-prompt" })]),
    )
  }, 20_000)

  it("restricts a coordinator created with the minimal preset to its tool rows", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "minimal", "test-minimal")
    await chooseModel(stub, project.coordinatorId)
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).not.toContain("set_model")
    expect(offers.latest().tools).toContain("remember")
    expect(offers.latest().tools).toContain("recall")
  }, 20_000)

  it("gives a thread its coordinator's preset", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "thread", "test-minimal")
    await chooseModel(stub, project.coordinatorId)
    const offers = recordOffers()

    await delegateThread(stub, project.coordinatorId, offers)

    const offered = threadOffer(offers)
    expect(offered, JSON.stringify(offers.seen.map((offer) => offer.tools))).toBeDefined()
    if (offered === undefined) return
    for (const name of FILES) expect(offered.tools, name).not.toContain(name)
    expect(offered.tools).toContain("remember")
  }, 20_000)

  it("selects a preset on a blank conversation and refuses one that has started", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "select")
    await chooseModel(stub, project.coordinatorId)

    const selected = await cmd(stub, `select-${crypto.randomUUID()}`, "preset.select", {
      conversation: project.coordinatorId,
      preset: "test-minimal",
    })
    expect(selected.result, JSON.stringify(selected)).toMatchObject({
      conversation: project.coordinatorId,
      preset: "test-minimal",
    })

    const offers = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])
    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)

    const locked = await cmd(stub, `select-${crypto.randomUUID()}`, "preset.select", {
      conversation: project.coordinatorId,
      preset: "test-all",
    })
    expect(locked).toMatchObject({ ok: false, error: { code: "bad_args" } })
  }, 20_000)

  it("reads a preset row's definition live", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "live", "test-minimal")
    await chooseModel(stub, project.coordinatorId)
    const restricted = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(restricted)])
    for (const name of FILES) expect(restricted.latest().tools, name).not.toContain(name)

    await install(stub, rows("all"))

    const opened = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(opened)])
    expect(opened.latest().tools).toEqual(expect.arrayContaining(FILES))
  }, 20_000)

  it("applies a project preset change to the next turn", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "update", "test-minimal")
    await chooseModel(stub, project.coordinatorId)
    const restricted = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(restricted)])
    for (const name of FILES) expect(restricted.latest().tools, name).not.toContain(name)

    const updated = await cmd(stub, `update-${crypto.randomUUID()}`, "project.update", {
      id: project.id,
      preset: "test-all",
    })
    expect(updated.result, JSON.stringify(updated)).toMatchObject({ preset: "test-all" })

    const opened = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(opened)])
    expect(opened.latest().tools).toEqual(expect.arrayContaining(FILES))
  }, 20_000)

  it("falls back to the default when the recorded preset is removed", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "removed", "test-minimal")
    await chooseModel(stub, project.coordinatorId)
    const restricted = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(restricted)])
    for (const name of FILES) expect(restricted.latest().tools, name).not.toContain(name)

    const removed = await cmd(stub, `remove-${crypto.randomUUID()}`, "bundle.remove", { package: PACKAGE })
    expect(removed.result, JSON.stringify(removed)).toMatchObject({ application: "applied", package: PACKAGE })

    const listed = await cmd(stub, `list-${crypto.randomUUID()}`, "preset.list")
    expect(listed.result, JSON.stringify(listed)).toMatchObject({
      conversations: [{ conversation: project.coordinatorId, preset: "test-minimal" }],
    })

    const restored = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(restored)])
    expect(restored.latest().tools).toEqual(expect.arrayContaining(FILES))
  }, 20_000)

  it("keeps the record and the restriction after an eviction", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "evicted", "test-minimal")
    await chooseModel(stub, project.coordinatorId)
    await evictDurableObject(stub)
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("lists presets in order with the default and each conversation's record", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "listed", "test-minimal")

    const listed = await cmd(stub, `list-${crypto.randomUUID()}`, "preset.list")
    expect(listed.result, JSON.stringify(listed)).toMatchObject({
      presets: expect.arrayContaining([
        expect.objectContaining({ id: "test-all", name: "Test all", plugins: "all" }),
        expect.objectContaining({ id: "test-minimal", name: "Test minimal", plugins: [...MINIMAL] }),
      ]),
      default: "full",
      conversations: [{ conversation: project.coordinatorId, preset: "test-minimal" }],
    })
  }, 20_000)

  it("rejects an unknown conversation and an unknown preset with bad_args", async () => {
    const stub = fresh()
    await install(stub, rows())
    const project = await makeProject(stub, "bad")

    const unknownConversation = await cmd(stub, `select-${crypto.randomUUID()}`, "preset.select", {
      conversation: 999_999,
      preset: "test-minimal",
    })
    expect(unknownConversation).toMatchObject({ ok: false, error: { code: "bad_args" } })

    const unknownPreset = await cmd(stub, `select-${crypto.randomUUID()}`, "preset.select", {
      conversation: project.coordinatorId,
      preset: "nope",
    })
    expect(unknownPreset).toMatchObject({ ok: false, error: { code: "bad_args" } })

    const unknownProject = await cmd(stub, `create-${crypto.randomUUID()}`, "project.create", {
      slug: "ghost",
      name: "ghost",
      preset: "nope",
    })
    expect(unknownProject).toMatchObject({ ok: false, error: { code: "bad_args" } })
  }, 20_000)

  it("keeps the presets row active when the default names no preset, as dsh resolves it only on use", async () => {
    const stub = fresh()
    await install(stub, rows())

    const configured = await cmd(stub, `configure-${crypto.randomUUID()}`, "plugin.configure", {
      id: "presets",
      config: { default: "nope" },
    })
    expect(configured.result, JSON.stringify(configured)).toMatchObject({
      application: "applied",
      row: { id: "presets", state: { kind: "active" } },
    })
  }, 20_000)
})

describe("prompts", () => {
  it("round-trips prompts in name order and deletes them", async () => {
    const stub = fresh()

    expect(await cmd(stub, "prompt-put-1", "prompt.put", { name: "tone", text: "Be terse." })).toMatchObject({
      ok: true,
      result: { name: "tone", text: "Be terse." },
    })
    expect(
      await cmd(stub, "prompt-put-2", "prompt.put", {
        name: "format",
        description: "How to shape a reply.",
        text: "Use bullets.",
      }),
    ).toMatchObject({
      ok: true,
      result: { name: "format", description: "How to shape a reply.", text: "Use bullets." },
    })
    expect(await cmd(stub, "prompt-put-3", "prompt.put", { name: "tone", text: "Be brief." })).toMatchObject({
      ok: true,
      result: { name: "tone", text: "Be brief." },
    })

    expect((await cmd(stub, "prompt-list-1", "prompt.list")).result).toEqual([
      { name: "format", description: "How to shape a reply.", text: "Use bullets.", source: { kind: "stored" } },
      { name: "tone", text: "Be brief.", source: { kind: "stored" } },
    ])

    expect((await cmd(stub, "prompt-delete-1", "prompt.delete", { name: "tone" })).result).toEqual({ name: "tone" })
    expect((await cmd(stub, "prompt-delete-2", "prompt.delete", { name: "tone" })).result).toEqual({ name: "tone" })
    expect((await cmd(stub, "prompt-list-2", "prompt.list")).result).toEqual([
      { name: "format", description: "How to shape a reply.", text: "Use bullets.", source: { kind: "stored" } },
    ])
  }, 20_000)

  it("rejects a bad prompt name and text over the limit", async () => {
    const stub = fresh()

    expect(await cmd(stub, "prompt-bad-1", "prompt.put", { name: "Bad Name", text: "x" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await cmd(stub, "prompt-bad-2", "prompt.put", { name: "a".repeat(65), text: "x" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await cmd(stub, "prompt-bad-3", "prompt.put", { name: "ok", text: "x".repeat(8_001) })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect((await cmd(stub, "prompt-list-3", "prompt.list")).result).toEqual([])
  }, 20_000)
})
