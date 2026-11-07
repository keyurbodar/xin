import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, setRow, type OfferLog, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const FILES = ["read", "write", "edit"]
const THREAD_PROMPT = "You are a thread named"

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
})
