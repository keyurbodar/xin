import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, setRow, type Ack, type OfferLog, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const FILES = ["read", "write", "edit"]
const THREAD_PROMPT = "You are a thread named"
const HOUSE_TEXT = "Answer in plain English. HOUSE-STYLE-PROMPT."
const EXTRA_TEXT = "Mention the weather. EXTRA-STYLE-PROMPT."

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

async function assign(stub: Stub, projectId: string, preset: string): Promise<void> {
  const outcome = await cmd(stub, `assign-${preset}-${crypto.randomUUID()}`, "preset.assign", { projectId, preset })
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
}

async function assignConversation(stub: Stub, conversation: number, preset: string | null): Promise<Ack> {
  return cmd(stub, `assign-conv-${crypto.randomUUID()}`, "preset.assign", { conversation, preset })
}

const PROMPT_PRESETS = {
  default: "full",
  presets: {
    full: { title: "Full", description: "Every row.", tools: "all", prompts: "all" },
    silent: { title: "Silent", description: "No prompt rows.", tools: "all", prompts: "none" },
    house: { title: "House", description: "Only the house prompt.", tools: "all", prompts: ["house-style"] },
  },
}

const BUNDLE_PACKAGE = "xin-plugin-frag"
const BUNDLE_ROW = `${BUNDLE_PACKAGE}#frag`
const BUNDLE_TEXT = "Answer as a fragment. BUNDLE-STYLE-PROMPT."

const BUNDLE_PRESETS = {
  default: "full",
  presets: {
    full: { title: "Full", description: "Every row.", tools: "all", prompts: "all" },
    fragment: {
      title: "Fragment",
      description: "Only the bundle's prompt.",
      tools: "all",
      prompts: [BUNDLE_ROW],
    },
    silent: { title: "Silent", description: "No prompt rows.", tools: "all", prompts: "none" },
  },
}

async function configurePresets(stub: Stub, config: unknown = PROMPT_PRESETS): Promise<void> {
  const configured = await cmd(stub, `configure-${crypto.randomUUID()}`, "plugin.configure", {
    id: "presets",
    config,
  })
  expect(configured.result, JSON.stringify(configured)).toMatchObject({ application: "applied" })
}

async function insertPrompt(stub: Stub, id: string, text: string): Promise<void> {
  const inserted = await cmd(stub, `prompt-${id}-${crypto.randomUUID()}`, "plugin.insert", {
    id,
    plugin: "prompt",
    config: { text },
  })
  expect(inserted.result, JSON.stringify(inserted)).toMatchObject({ application: "applied" })
}

async function insertPromptBundle(stub: Stub): Promise<void> {
  const inserted = await cmd(stub, `bundle-${crypto.randomUUID()}`, "bundle.put", {
    package: BUNDLE_PACKAGE,
    rows: [{ id: "frag", plugin: "prompt", config: { text: BUNDLE_TEXT } }],
  })
  expect(inserted.result, JSON.stringify(inserted)).toMatchObject({ application: "applied" })
}

describe("presets", () => {
  it("offers the files tools under the default full preset", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "full")
    await chooseModel(stub, project.coordinatorId)
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().tools).toEqual(expect.arrayContaining(FILES))
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("restricts the coordinator to the minimal preset's tool rows", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "minimal")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("remember")
    expect(offers.latest().tools).toContain("recall")
  }, 20_000)

  it("gives a thread delegated after the assignment the same restriction", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "thread")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")
    const offers = recordOffers()
    respond([threadStep(offers), threadStep(offers), threadStep(offers), threadStep(offers)])

    await runInDurableObject(stub, async (home: Home) => {
      const outcome = await home.loader.ctx.threads.delegate(
        { conversationId: project.coordinatorId as ConversationId, taskId: "presets-test" },
        { task: "check the tools", title: "Tools", mode: "async", clientRequestId: `thread-${crypto.randomUUID()}` },
        context,
      )
      expect(outcome.kind, JSON.stringify(outcome)).toBe("started")
    })
    await until(() => offers.seen.some((offer) => offer.system.includes(THREAD_PROMPT)))

    const offered = offers.seen.find((offer) => offer.system.includes(THREAD_PROMPT))
    expect(offered, JSON.stringify(offers.seen.map((offer) => offer.tools))).toBeDefined()
    if (offered === undefined) return
    for (const name of FILES) expect(offered.tools, name).not.toContain(name)
    expect(offered.tools).toContain("remember")
    expect(offered.tools).toContain("recall")
  }, 20_000)

  it("restores the tools when the project returns to full", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "restore")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")
    await assign(stub, project.id, "full")
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().tools).toEqual(expect.arrayContaining(FILES))
  }, 20_000)

  it("keeps the restriction after an eviction", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "evicted")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")
    await evictDurableObject(stub)
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("ends on the assigned preset after an immediate restart", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "restarted")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")

    const restarted = await cmd(stub, `restart-${crypto.randomUUID()}`, "system.restart", {})
    expect(restarted.result).toMatchObject({ application: "restarting" })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const offers = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    for (const name of FILES) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("hides current_time under a preset that does not allow its tool row", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "time")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().tools).not.toContain("current_time")
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("restores every tool when the presets row is disabled", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "disabled")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")

    await setRow(stub, "presets", false)

    const offers = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().tools).toEqual(expect.arrayContaining(FILES))
    expect(offers.latest().tools).toContain("current_time")
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("falls back to the default when the configured presets drop the assigned one", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "fallback")
    await chooseModel(stub, project.coordinatorId)
    await assign(stub, project.id, "minimal")

    const configured = await cmd(stub, "presets-configure", "plugin.configure", {
      id: "presets",
      config: {
        default: "full",
        presets: { full: { title: "Full", description: "Every tool row.", tools: "all" } },
      },
    })
    expect(configured.result).toMatchObject({ application: "applied" })
    const listed = await cmd(stub, "presets-list", "preset.list")
    expect(listed.result).toMatchObject({ projects: [{ projectId: project.id, preset: "full" }] })
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().tools).toEqual(expect.arrayContaining(FILES))
  }, 20_000)

  it("rejects an unknown preset and an unknown project with bad_args", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "bad")

    const unknownPreset = await cmd(stub, "bad-preset", "preset.assign", { projectId: project.id, preset: "nope" })
    expect(unknownPreset).toMatchObject({ ok: false, error: { code: "bad_args" } })

    const unknownProject = await cmd(stub, "bad-project", "preset.assign", {
      projectId: "prj_missing",
      preset: "minimal",
    })
    expect(unknownProject).toMatchObject({ ok: false, error: { code: "bad_args" } })
  }, 20_000)

  it("hides every prompt row's section under a preset with prompts none", async () => {
    const stub = fresh()
    await insertPrompt(stub, "house-style", HOUSE_TEXT)
    const project = await makeProject(stub, "prompt-none")
    await chooseModel(stub, project.coordinatorId)
    await configurePresets(stub)
    await assign(stub, project.id, "silent")
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().system).not.toContain(HOUSE_TEXT)
    expect(offers.latest().tools).toContain("remember")
  }, 20_000)

  it("keeps only the prompt rows a preset allows", async () => {
    const stub = fresh()
    await insertPrompt(stub, "house-style", HOUSE_TEXT)
    await insertPrompt(stub, "extra-style", EXTRA_TEXT)
    const project = await makeProject(stub, "prompt-house")
    await chooseModel(stub, project.coordinatorId)
    await configurePresets(stub)
    await assign(stub, project.id, "house")
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().system).toContain(HOUSE_TEXT)
    expect(offers.latest().system).not.toContain(EXTRA_TEXT)
  }, 20_000)

  it("selects a bundle-provided prompt row by its qualified row id", async () => {
    const stub = fresh()
    await insertPromptBundle(stub)
    const project = await makeProject(stub, "prompt-bundle")
    await chooseModel(stub, project.coordinatorId)
    await configurePresets(stub, BUNDLE_PRESETS)

    await assign(stub, project.id, "fragment")
    const shown = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(shown)])
    expect(shown.latest().system).toContain(BUNDLE_TEXT)

    await assign(stub, project.id, "silent")
    const hidden = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(hidden)])
    expect(hidden.latest().system).not.toContain(BUNDLE_TEXT)

    await assign(stub, project.id, "fragment")
    const again = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(again)])
    expect(again.latest().system).toContain(BUNDLE_TEXT)
  }, 20_000)

  it("lets a conversation assignment win over the project's and restores the project's when cleared", async () => {
    const stub = fresh()
    await insertPrompt(stub, "house-style", HOUSE_TEXT)
    const project = await makeProject(stub, "conversation")
    await chooseModel(stub, project.coordinatorId)
    await configurePresets(stub)

    const assigned = await assignConversation(stub, project.coordinatorId, "silent")
    expect(assigned.result, JSON.stringify(assigned)).toMatchObject({
      conversation: project.coordinatorId,
      preset: { id: "silent" },
    })
    expect((await cmd(stub, "list-conversation", "preset.list")).result).toMatchObject({
      conversations: [{ conversation: project.coordinatorId, preset: "silent" }],
    })
    const offers = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])
    expect(offers.latest().system).not.toContain(HOUSE_TEXT)

    const cleared = await assignConversation(stub, project.coordinatorId, null)
    expect(cleared.result, JSON.stringify(cleared)).toMatchObject({
      conversation: project.coordinatorId,
      preset: null,
    })
    expect((await cmd(stub, "list-cleared", "preset.list")).result).toMatchObject({ conversations: [] })

    const restored = recordOffers()
    await turn(stub, project.coordinatorId, "go", [coordinatorStep(restored)])
    expect(restored.latest().system).toContain(HOUSE_TEXT)
  }, 20_000)

  it("gives a thread created later the coordinator's conversation preset", async () => {
    const stub = fresh()
    await insertPrompt(stub, "house-style", HOUSE_TEXT)
    const project = await makeProject(stub, "thread-conversation")
    await chooseModel(stub, project.coordinatorId)
    await configurePresets(stub)
    await assignConversation(stub, project.coordinatorId, "silent")
    const offers = recordOffers()
    respond([threadStep(offers), threadStep(offers), threadStep(offers), threadStep(offers)])

    await runInDurableObject(stub, async (home: Home) => {
      const outcome = await home.loader.ctx.threads.delegate(
        { conversationId: project.coordinatorId as ConversationId, taskId: "presets-conversation" },
        {
          task: "check the prompts",
          title: "Prompts",
          mode: "async",
          clientRequestId: `thread-${crypto.randomUUID()}`,
        },
        context,
      )
      expect(outcome.kind, JSON.stringify(outcome)).toBe("started")
    })
    await until(() => offers.seen.some((offer) => offer.system.includes(THREAD_PROMPT)))

    const offered = offers.seen.find((offer) => offer.system.includes(THREAD_PROMPT))
    expect(offered, JSON.stringify(offers.seen.map((offer) => offer.system))).toBeDefined()
    if (offered === undefined) return
    expect(offered.system).not.toContain(HOUSE_TEXT)
  }, 20_000)

  it("keeps a conversation assignment after an eviction", async () => {
    const stub = fresh()
    await insertPrompt(stub, "house-style", HOUSE_TEXT)
    const project = await makeProject(stub, "conversation-evicted")
    await chooseModel(stub, project.coordinatorId)
    await configurePresets(stub)
    await assignConversation(stub, project.coordinatorId, "silent")
    await evictDurableObject(stub)
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "go", [coordinatorStep(offers)])

    expect(offers.latest().system).not.toContain(HOUSE_TEXT)
  }, 20_000)

  it("rejects an unknown conversation and an unknown conversation preset with bad_args", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "conversation-bad")

    const unknownConversation = await assignConversation(stub, 999_999, "minimal")
    expect(unknownConversation).toMatchObject({ ok: false, error: { code: "bad_args" } })

    const unknownPreset = await assignConversation(stub, project.coordinatorId, "nope")
    expect(unknownPreset).toMatchObject({ ok: false, error: { code: "bad_args" } })
  }, 20_000)
})
