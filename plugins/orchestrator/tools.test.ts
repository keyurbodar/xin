import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  fauxAssistantMessage,
  getCurrentSystemMessage,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
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
type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const requests: TranscriptContext[] = []

const record: FauxResponseStep = (request) => {
  requests.push(request)
  return fauxAssistantMessage("noted")
}

const offered = (): readonly string[] => {
  const request = requests.at(-1)
  if (request === undefined) throw new Error("the faux model has not been called")
  return getCurrentSystemMessage(request.messages)?.toolsAdded?.map((tool) => tool.name) ?? []
}

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const rowOf = async (stub: Stub, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${id}-${crypto.randomUUID()}`, "plugin.list")
  return Array.isArray(listed.result) ? listed.result.find((row) => field(row, "id") === id) : undefined
}

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

async function turn(stub: Stub, coordinatorId: number, text: string): Promise<void> {
  respond([record])
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.submit({ type: "input", content: text, requestId: `turn-${crypto.randomUUID()}` }, context)
    await home.harness.waitForIdle(context)
  })
}

const setRow = async (stub: Stub, enabled: boolean): Promise<void> => {
  const ack = await cmd(stub, `tools-${enabled}-${crypto.randomUUID()}`, "plugin.enable", {
    id: "tool-orchestrator",
    enabled,
  })
  expect(ack).toMatchObject({ ok: true, result: { application: "applied", row: { disabled: !enabled } } })
}

describe("orchestrator tool row", () => {
  it("offers the orchestrator tools only while its own row is active", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "tool-row")
    await chooseModel(stub, project.coordinatorId)

    await turn(stub, project.coordinatorId, "what can you do")
    expect(offered()).toEqual(expect.arrayContaining([...TOOLS]))
    expect(offered()).toContain("current_time")

    await setRow(stub, false)
    await turn(stub, project.coordinatorId, "still there")
    for (const name of TOOLS) expect(offered(), name).not.toContain(name)
    expect(offered()).toContain("current_time")

    expect(field(await rowOf(stub, "orchestrator"), "state")).toEqual({ kind: "active" })
    expect(field(await rowOf(stub, "tool-orchestrator"), "state")).toEqual({ kind: "disabled" })
    const service = await runInDurableObject(stub, async (home: Home) =>
      home.extension("xin.orchestrator").tasks?.map((task) => task.definition.name),
    )
    expect(service).toEqual(["xin.anchor", "xin.reporter"])
    const sent = await cmd(stub, "service-op", "thread.send", { threadId: 999, text: "still here", mode: "steer" })
    expect(sent).toMatchObject({ ok: false, error: { code: "bad_args", message: "no thread 999" } })

    await setRow(stub, true)
    await turn(stub, project.coordinatorId, "back again")
    expect(offered()).toEqual(expect.arrayContaining([...TOOLS]))
  }, 20_000)
})
