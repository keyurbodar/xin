import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { JsonObject } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { respond } from "../../test/plugins/m8.ts"
import { fresh, recordOffers, turn, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import * as goalsRow from "./index.ts"
import * as toolsRow from "./tools.ts"

const context = BACKGROUND_CONTEXT
const POLICY = "Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds"

type Result = { readonly text: string; readonly isError: boolean }

async function mount(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    if (home.loader.ctx.get("goals") === undefined && !home.loader.rows().some((row) => row.id === "goals")) {
      await home.loader.ctx.plugin(goalsRow)
    }
    if (!home.loader.ctx.pi.installed.has("tool-goals") && !home.loader.rows().some((row) => row.id === "tool-goals")) {
      await home.loader.ctx.plugin(toolsRow)
    }
  })
}

async function setup(): Promise<Stub> {
  const stub = fresh()
  await mount(stub)
  return stub
}

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })

async function toolResults(stub: Stub): Promise<Result[]> {
  return runInDurableObject(stub, async (home: Home) => {
    const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)
    return page.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult"
          ? [
              {
                text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
                isError: message.isError,
              },
            ]
          : [],
      ),
    )
  })
}

async function invoke(stub: Stub, name: string, args: JsonObject): Promise<Result> {
  respond([call(name, args), fauxAssistantMessage("done")])
  await turn(stub, `tools-${crypto.randomUUID()}`)
  const results = await toolResults(stub)
  const last = results.at(-1)
  if (last === undefined) throw new Error("the tool did not answer")
  return last
}

function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

const goalOf = (result: Result): Record<string, unknown> => {
  const outcome = json(result.text)
  const goal = outcome.goal
  return typeof goal === "object" && goal !== null ? (goal as Record<string, unknown>) : {}
}

describe("goal tools", () => {
  it("offers the three goal tools and dsh's policy paragraph", async () => {
    const stub = await setup()
    const offers = recordOffers()
    respond([offers.step("ok")])
    await turn(stub, `offers-${crypto.randomUUID()}`)

    expect(offers.latest().tools).toEqual(expect.arrayContaining(["create_goal", "get_goal", "update_goal"]))
    expect(offers.latest().system).toContain(POLICY)
  })

  it("answers create_goal and get_goal with the same compact JSON", async () => {
    const stub = await setup()
    const created = await invoke(stub, "create_goal", { objective: "finish the release", max_goal_rounds: 3 })

    expect(created.isError).toBe(false)
    expect(json(created.text)).toMatchObject({
      goal: {
        revision: 1,
        objective: "finish the release",
        phase: "active",
        roundsStarted: 0,
        maxGoalRounds: 3,
      },
      activation: "armed",
    })
    expect(Object.keys(json(created.text)).toSorted()).toEqual(["activation", "goal"])

    const read = await invoke(stub, "get_goal", {})
    expect(Object.keys(json(read.text)).toSorted()).toEqual(["activation", "goal"])
    expect(goalOf(read)).toMatchObject({ id: goalOf(created).id, revision: 1, phase: "active" })
  })

  it("requires blocked_reason only for blocked and ignores the replacement fields elsewhere", async () => {
    const stub = await setup()
    const created = await invoke(stub, "create_goal", { objective: "finish the release", max_goal_rounds: 3 })
    const id = String(goalOf(created).id)

    const refused = await invoke(stub, "update_goal", { goal_id: id, revision: 1, action: "blocked" })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("blocked_reason")

    const paused = await invoke(stub, "update_goal", {
      goal_id: id,
      revision: 1,
      action: "pause",
      objective: "replaced",
      max_goal_rounds: 9,
      blocked_reason: "ignored",
    })
    expect(paused.isError).toBe(false)
    expect(goalOf(paused)).toMatchObject({
      revision: 2,
      phase: "paused",
      objective: "finish the release",
      maxGoalRounds: 3,
    })

    const resumed = await invoke(stub, "update_goal", { goal_id: id, revision: 2, action: "resume" })
    expect(json(resumed.text)).toMatchObject({ goal: { revision: 3, phase: "active" }, activation: "armed" })

    const blocked = await invoke(stub, "update_goal", {
      goal_id: id,
      revision: 3,
      action: "blocked",
      blocked_reason: "missing credential",
    })
    expect(goalOf(blocked)).toMatchObject({
      revision: 4,
      phase: "blocked",
      blockedReason: { code: "model-reported", message: "missing credential" },
    })

    const stale = await invoke(stub, "update_goal", { goal_id: id, revision: 1, action: "complete" })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain("stale_revision")

    const completed = await invoke(stub, "update_goal", { goal_id: id, revision: 4, action: "complete" })
    expect(json(completed.text)).toMatchObject({ goal: { revision: 5, phase: "complete" }, activation: "disarmed" })
  })
})
