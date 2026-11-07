import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import {
  cmd,
  eventually,
  field,
  fresh,
  recordOffers,
  rowOf,
  rowState,
  setRow,
  type Stub,
  turn,
} from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const TOOLS = ["schedule_create", "schedule_list", "schedule_view", "schedule_edit"]
const POLICY =
  "Only create or modify scheduled tasks at the user's explicit request; " +
  "prior explicit authorization for the running scheduled task remains valid."
const RRULE = "DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY;BYMINUTE=0"

type ToolResult = { readonly name: string; readonly text: string; readonly isError: boolean }

type Inbound = { readonly body: string; readonly target: number }

type Args = Record<string, string | number | boolean>

const call = (name: string, args: Args): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })

const ids = (): string => crypto.randomUUID()

async function toolResults(home: Home, conversationId: ConversationId): Promise<ToolResult[]> {
  const conversation = await home.harness.conversation(conversationId, BACKGROUND_CONTEXT)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)
  return page.items.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult"
        ? [
            {
              name: message.toolName,
              text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
              isError: message.isError,
            },
          ]
        : [],
    ),
  )
}

async function callTools(stub: Stub, ...steps: FauxResponseStep[]): Promise<ToolResult[]> {
  respond([...steps, fauxAssistantMessage("done")])
  await turn(stub, `turn-${ids()}`)
  const results = await runInDurableObject(stub, async (home: Home) => toolResults(home, (await home.root()).id))
  return results.slice(-steps.length)
}

async function callOn(stub: Stub, conversationId: number, step: FauxResponseStep): Promise<ToolResult[]> {
  respond([step, fauxAssistantMessage("done")])
  return runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT)
    if (conversation === undefined) throw new Error("no conversation")
    await conversation.configure({ model: M8_MODEL }, BACKGROUND_CONTEXT)
    await conversation.submit({ type: "input", content: "go", requestId: `t-${ids()}` }, BACKGROUND_CONTEXT)
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    return toolResults(home, conversationId as ConversationId)
  })
}

const parse = (result: ToolResult | undefined): unknown => JSON.parse(result?.text ?? "null")

const rows = (home: Home): Promise<readonly Inbound[]> =>
  home.db.all<Inbound>("SELECT body, target FROM inbound ORDER BY id")

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const created = async (stub: Stub, args: Record<string, unknown>): Promise<string> => {
  const ack = await cmd(stub, `create-${ids()}`, "schedule.create", args)
  expect(ack, JSON.stringify(ack)).toMatchObject({ ok: true })
  return String(field(ack.result, "id"))
}

describe("tool-schedules row", () => {
  it("offers the four schedule tools and their policy only while its row is active", async () => {
    const stub = fresh()
    const offers = recordOffers()

    respond([offers.step()])
    await turn(stub, `turn-${ids()}`)
    expect(offers.latest().tools).toEqual(expect.arrayContaining(TOOLS))
    expect(offers.latest().system).toContain(POLICY)

    await setRow(stub, "tool-schedules", false)
    expect(await rowOf(stub, "schedules")).toMatchObject({ disabled: false, state: { kind: "active" } })
    expect(await rowOf(stub, "tool-schedules")).toMatchObject({ disabled: true, state: { kind: "disabled" } })

    respond([offers.step()])
    await turn(stub, `turn-${ids()}`)
    const hidden = offers.latest().tools
    for (const name of TOOLS) expect(hidden).not.toContain(name)
    expect(offers.latest().system).not.toContain(POLICY)

    const id = await created(stub, { title: "Kept", rrule: RRULE, tz: "UTC", prompt: "ping" })
    const viewed = await cmd(stub, `view-${ids()}`, "schedule.view", { id })
    expect(viewed, JSON.stringify(viewed)).toMatchObject({ ok: true, result: { id, prompt: "ping" } })

    await setRow(stub, "tool-schedules", true)
    respond([offers.step()])
    await turn(stub, `turn-${ids()}`)
    expect(offers.latest().tools).toEqual(expect.arrayContaining(TOOLS))
    expect(await rowState(stub, "tool-schedules")).toEqual({ kind: "active" })
  })

  it("creates, lists with a filter and a page, and views an unknown id", async () => {
    const stub = fresh()
    const results = await callTools(
      stub,
      call("schedule_create", { title: "Hydrate", prompt: "drink water", rrule: RRULE, target: "this_session" }),
      call("schedule_create", { title: "Report", prompt: "write the report", rrule: RRULE, target: "new_once" }),
      call("schedule_create", { title: "Sweep", prompt: "check the inbox", rrule: RRULE, target: "new" }),
      call("schedule_list", { active: true }),
      call("schedule_list", { active: true, limit: 1, offset: 1 }),
      call("schedule_list", { active: false }),
      call("schedule_view", { id: "missing" }),
    )

    const first = parse(results[0])
    expect(first).toMatchObject({
      title: "Hydrate",
      prompt: "drink water",
      rrule: "FREQ=DAILY;BYMINUTE=0",
      target: "this_session",
      active: true,
      nextAt: "2099-01-01T09:00:00.000Z",
    })
    expect(field(first, "updatedAt")).toEqual(expect.any(String))
    expect(results[0]?.isError).toBe(false)

    const page = parse(results[3])
    expect(page).toMatchObject({ shown: 3, total: 3, limit: 100, offset: 0 })
    const paged = parse(results[4])
    expect(paged).toMatchObject({ shown: 1, total: 3, limit: 1, offset: 1 })

    const paused = parse(results[5])
    expect(paused).toMatchObject({ items: [], shown: 0, total: 0 })

    expect(parse(results[6])).toEqual({ id: "missing", code: "schedule_not_found" })
  })

  it("edits a prompt and an rrule, and refuses a stale expectedUpdatedAt", async () => {
    const stub = fresh()
    const [createdTool] = await callTools(
      stub,
      call("schedule_create", { title: "Hydrate", prompt: "drink water", rrule: RRULE, target: "this_session" }),
    )
    const task = parse(createdTool)
    const id = String(field(task, "id"))
    const updatedAt = String(field(task, "updatedAt"))

    const [edited] = await callTools(
      stub,
      call("schedule_edit", {
        id,
        action: "update",
        prompt: "drink more water",
        rrule: "DTSTART:20990201T100000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0",
        expectedUpdatedAt: updatedAt,
      }),
    )
    const after = parse(edited)
    expect(after).toMatchObject({
      id,
      prompt: "drink more water",
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0",
    })
    expect(after).not.toEqual(task)

    const [conflict] = await callTools(
      stub,
      call("schedule_edit", { id, action: "update", title: "Nothing", expectedUpdatedAt: updatedAt }),
    )
    expect(parse(conflict)).toEqual({ id, code: "schedule_conflict" })

    const [viewed] = await callTools(stub, call("schedule_view", { id }))
    expect(parse(viewed)).toMatchObject({ title: "Hydrate", prompt: "drink more water" })

    const [staleDelete] = await callTools(
      stub,
      call("schedule_edit", { id, action: "delete", expectedUpdatedAt: updatedAt }),
    )
    expect(parse(staleDelete)).toEqual({ id, code: "schedule_conflict" })
  })

  it("pauses delivery and resumes it", async () => {
    const stub = fresh()
    const kept = await created(stub, {
      id: "paused",
      title: "Paused",
      at: Date.now() + 900,
      tz: "UTC",
      prompt: "paused delivery",
    })
    const resumed = await created(stub, {
      id: "resumed",
      title: "Resumed",
      at: Date.now() + 1_200,
      tz: "UTC",
      prompt: "resumed delivery",
    })

    const results = await callTools(
      stub,
      call("schedule_edit", { id: kept, action: "update", active: false }),
      call("schedule_edit", { id: resumed, action: "update", active: false }),
      call("schedule_edit", { id: resumed, action: "update", active: true }),
    )
    expect(parse(results[0])).toMatchObject({ id: kept, active: false })
    expect(parse(results[1])).toMatchObject({ id: resumed, active: false })
    expect(parse(results[2])).toMatchObject({ id: resumed, active: true, nextAt: expect.any(String) })

    await delay(1_400)
    await runDurableObjectAlarm(stub)
    await eventually(stub, async (home: Home) => (await rows(home)).length > 0)
    const stored = await runInDurableObject(stub, (home: Home) => rows(home))
    const threads = stored.map((row) => field(JSON.parse(row.body), "threadId"))
    expect(threads).toContain("resumed")
    expect(threads).not.toContain("paused")
  })

  it("refuses a delegated subagent", async () => {
    const stub = fresh()
    const project = await cmd(stub, `project-${ids()}`, "project.create", { slug: "threads", name: "Threads" })
    const coordinator = Number(field(project.result, "coordinatorId"))
    await runInDurableObject(stub, async (home: Home) => {
      await home.harness.commit(async (tx) => {
        await tx.doc(ThreadDoc, coordinator as ConversationId)
      }, BACKGROUND_CONTEXT)
    })

    const results = await callOn(
      stub,
      coordinator,
      call("schedule_create", { title: "Child", prompt: "should not run", rrule: RRULE, target: "this_session" }),
    )
    expect(parse(results.at(-1))).toEqual({
      code: "subagent_session",
      message: "A delegated subagent cannot use scheduled tasks.",
    })
    const listed = await cmd(stub, `list-${ids()}`, "schedule.list")
    expect(listed.result).toMatchObject({ schedules: [] })
  })
})
