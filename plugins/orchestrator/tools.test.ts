import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, rowState, setRow } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const TOOLS = [
  "capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "thread_send",
  "thread_read",
  "thread_list",
] as const

type Stub = ReturnType<typeof fresh>

async function makeProject(stub: Stub, slug: string): Promise<{ readonly id: string; readonly coordinatorId: number }> {
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
    await conversation.submit({ type: "input", content: text, requestId: `turn-${crypto.randomUUID()}` }, context)
    await home.harness.waitForIdle(context)
  })
}

const messageText = (message: { readonly content: unknown }): string => {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const toolResults = async (stub: Stub, coordinatorId: number): Promise<string[]> =>
  runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) return []
    const page = await conversation.entries({ order: "ascending" }, 300, undefined, context)
    return page.items.flatMap((entry) =>
      (entry.model ?? []).filter((message) => message.role === "toolResult").map(messageText),
    )
  })

describe("orchestrator tool row", () => {
  it("offers the orchestrator tools only while its own row is active", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "tool-row")
    await chooseModel(stub, project.coordinatorId)
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "what can you do", [offers.step()])
    expect(offers.latest().tools).toEqual(expect.arrayContaining([...TOOLS]))
    expect(offers.latest().tools).toContain("current_time")

    await setRow(stub, "tool-orchestrator", false)
    await turn(stub, project.coordinatorId, "still there", [offers.step()])
    for (const name of TOOLS) expect(offers.latest().tools, name).not.toContain(name)
    expect(offers.latest().tools).toContain("current_time")

    expect(await rowState(stub, "orchestrator")).toEqual({ kind: "active" })
    expect(await rowState(stub, "tool-orchestrator")).toEqual({ kind: "disabled" })
    const service = await runInDurableObject(stub, async (home: Home) =>
      home.extension("xin.orchestrator").tasks?.map((task) => task.definition.name),
    )
    expect(service).toEqual(["xin.anchor", "xin.reporter"])
    const sent = await cmd(stub, "service-op", "thread.send", { threadId: 999, text: "still here", mode: "steer" })
    expect(sent).toMatchObject({ ok: false, error: { code: "bad_args", message: "no thread 999" } })

    await setRow(stub, "tool-orchestrator", true)
    await turn(stub, project.coordinatorId, "back again", [offers.step()])
    expect(offers.latest().tools).toEqual(expect.arrayContaining([...TOOLS]))
  }, 20_000)

  it("reports the plugin row states from the plugin manager", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "tool-caps")
    await chooseModel(stub, project.coordinatorId)
    const offers = recordOffers()

    await turn(stub, project.coordinatorId, "capabilities please", [
      offers.wrap(() => fauxAssistantMessage([fauxToolCall("capabilities", {})], { stopReason: "toolUse" })),
      offers.step(),
    ])
    const report = (await toolResults(stub, project.coordinatorId)).find((text) => text.includes("plugins:"))
    expect(report).toBeDefined()
    expect(report).toContain("orchestrator (active)")
    expect(report).toContain("tool-orchestrator (active)")
  }, 20_000)
})
