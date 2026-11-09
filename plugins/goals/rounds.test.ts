import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { GoalView } from "../../src/contracts/goals.ts"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, eventually, fresh, setRow, turn, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import * as goalsRow from "./index.ts"
import * as roundsRow from "./rounds.ts"

const context = BACKGROUND_CONTEXT
const OBJECTIVE = "finish the release"

async function mount(stub: Stub, options: { readonly rounds?: boolean } = {}): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    if (home.loader.ctx.get("goals") === undefined) {
      if (!home.loader.rows().some((row) => row.id === "goals")) await home.loader.ctx.plugin(goalsRow)
    }
    const composed = home.loader.rows().some((row) => row.id === "goal-rounds")
    if (options.rounds === false) {
      if (composed) await home.loader.update("goal-rounds", { disabled: true })
      return
    }
    if (!home.loader.ctx.pi.installed.has("goal-rounds") && !composed) await home.loader.ctx.plugin(roundsRow)
  })
}

async function setup(
  options: { readonly rounds?: boolean } = {},
): Promise<{ stub: Stub; conversation: ConversationId }> {
  const stub = fresh()
  await mount(stub, options)
  const conversation = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
  return { stub, conversation }
}

async function createGoal(stub: Stub, maxRounds: number): Promise<GoalView> {
  return runInDurableObject(stub, async (home: Home) => {
    const outcome = await home.loader.ctx.goals.set({
      conversation: (await home.root()).id,
      action: "create",
      objective: OBJECTIVE,
      maxRounds,
    })
    if (outcome.kind !== "ok" || outcome.goal === null) throw new Error("the goal was not created")
    return outcome.goal
  })
}

const goalNow = (stub: Stub): Promise<GoalView | null> =>
  runInDurableObject(stub, async (home: Home) => home.loader.ctx.goals.get((await home.root()).id))

const pauseGoal = (stub: Stub, id: string, revision: number): Promise<unknown> =>
  runInDurableObject(stub, async (home: Home) =>
    home.loader.ctx.goals.set({ conversation: (await home.root()).id, action: "pause", id, revision }),
  )

const resumeGoal = (stub: Stub, id: string, revision: number): Promise<unknown> =>
  runInDurableObject(stub, async (home: Home) =>
    home.loader.ctx.goals.set({ conversation: (await home.root()).id, action: "resume", id, revision }),
  )

type Inbound = { readonly commandId: string; readonly status: string }

const intakeRows = async (stub: Stub): Promise<Inbound[]> =>
  (await runInDurableObject(stub, (home: Home) => home.intake())).map((item) => ({
    commandId: item.commandId,
    status: item.status,
  }))

const goalRows = async (stub: Stub): Promise<Inbound[]> =>
  (await intakeRows(stub)).filter((row) => row.commandId.startsWith("goal:"))

const pendingGoalCommands = async (stub: Stub): Promise<string[]> =>
  (await goalRows(stub)).filter((row) => row.status === "pending").map((row) => row.commandId)

const goalCommand = (goalId: string, round: number): RegExp => new RegExp(`^goal:${goalId}:${round}:[1-9][0-9]*$`)

async function fire(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
  await runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))
}

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const rounds = (stub: Stub): Promise<string[]> =>
  runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.root()
    const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
    return page.items.flatMap((entry) =>
      (entry.model ?? [])
        .flatMap((message) => (message.role === "user" ? [textOf(message)] : []))
        .filter((text) => text.includes("<goal_round>")),
    )
  })

describe("goal rounds", () => {
  it("advances one round after another while idle and blocks at the cap", async () => {
    const { stub } = await setup()
    respond([
      fauxAssistantMessage("noted one"),
      fauxAssistantMessage("noted two"),
      fauxAssistantMessage("noted three"),
      fauxAssistantMessage("noted four"),
    ])
    const goal = await createGoal(stub, 3)

    await turn(stub, `rounds-start-${crypto.randomUUID()}`)
    const reserved = await goalRows(stub)
    expect(reserved).toHaveLength(1)
    expect(reserved[0]?.commandId).toMatch(goalCommand(goal.id, 1))

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 1, phase: "active", activation: "armed" })
    expect(await rounds(stub)).toHaveLength(1)

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 2, phase: "active" })

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({
      rounds: 3,
      phase: "blocked",
      activation: "disarmed",
      blocker: { code: "round-limit" },
    })
    expect(await rounds(stub)).toHaveLength(3)

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 3, phase: "blocked" })
    expect(await rounds(stub)).toHaveLength(3)
  })

  it("reserves the dropped round again under a new run after a pause and resume", async () => {
    const { stub } = await setup()
    respond([
      fauxAssistantMessage("idle one"),
      fauxAssistantMessage("round one"),
      fauxAssistantMessage("idle two"),
      fauxAssistantMessage("round two"),
      fauxAssistantMessage("unused"),
    ])
    const goal = await createGoal(stub, 5)

    await turn(stub, `drop-start-${crypto.randomUUID()}`)
    await fire(stub)
    const afterFirst = await goalNow(stub)
    if (afterFirst === null) throw new Error("the goal vanished")
    expect(afterFirst).toMatchObject({ rounds: 1, phase: "active", activation: "armed" })
    const dropped = await pendingGoalCommands(stub)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatch(goalCommand(goal.id, 2))

    await pauseGoal(stub, goal.id, afterFirst.revision)
    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 1, phase: "paused" })
    expect(await pendingGoalCommands(stub)).toEqual([])

    const resumed = await resumeGoal(stub, goal.id, afterFirst.revision + 1)
    expect(resumed).toMatchObject({ kind: "ok", goal: { phase: "active", activation: "armed" } })

    await turn(stub, `resume-start-${crypto.randomUUID()}`)
    const resent = await pendingGoalCommands(stub)
    expect(resent).toHaveLength(1)
    expect(resent[0]).toMatch(goalCommand(goal.id, 2))
    expect(resent[0]).not.toBe(dropped[0])

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 2, phase: "active" })
    const prompts = await rounds(stub)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("Round: 2/5")
  })

  it("gives successive runs distinct reservation ids and admits both rounds", async () => {
    const { stub } = await setup()
    respond([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")])
    const goal = await createGoal(stub, 5)

    await turn(stub, `distinct-start-${crypto.randomUUID()}`)
    const first = await pendingGoalCommands(stub)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(goalCommand(goal.id, 1))

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 1 })
    const second = await pendingGoalCommands(stub)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatch(goalCommand(goal.id, 2))
    expect(second[0]).not.toBe(first[0])

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 2 })
  })

  it("carries the goal_round prompt in one coordinator turn per round", async () => {
    const { stub } = await setup()
    respond([fauxAssistantMessage("first"), fauxAssistantMessage("second")])
    const goal = await createGoal(stub, 5)

    await turn(stub, `prompt-start-${crypto.randomUUID()}`)
    await fire(stub)

    const prompts = await rounds(stub)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("<goal_round>")
    expect(prompts[0]).toContain(`Objective: ${JSON.stringify(OBJECTIVE)}`)
    expect(prompts[0]).toContain("Round: 1/5")
    expect(prompts[0]).toContain("</goal_round>")
    expect(goal.rounds).toBe(0)
  })

  it("spends no round when the goal was paused after the reservation", async () => {
    const { stub } = await setup()
    respond([fauxAssistantMessage("idle"), fauxAssistantMessage("unused")])
    const goal = await createGoal(stub, 5)
    await turn(stub, `stale-start-${crypto.randomUUID()}`)

    await pauseGoal(stub, goal.id, goal.revision)
    await fire(stub)

    expect(await goalNow(stub)).toMatchObject({ rounds: 0, phase: "paused", revision: 2 })
    expect(await rounds(stub)).toHaveLength(0)
    expect((await goalRows(stub)).map((row) => row.status)).toEqual(["done"])
  })

  it("cancels a pending round when the owner writes", async () => {
    const { stub } = await setup()
    respond([fauxAssistantMessage("noted"), fauxAssistantMessage("human replied"), fauxAssistantMessage("round")])
    const goal = await createGoal(stub, 5)
    await turn(stub, `human-start-${crypto.randomUUID()}`)
    expect(await goalRows(stub)).toHaveLength(1)

    const sent = await cmd(stub, `human-${crypto.randomUUID()}`, "message.send", { text: "wait for me" })
    expect(sent.ok).toBe(true)
    expect(await goalRows(stub)).toEqual([])
    expect(await goalNow(stub)).toMatchObject({ rounds: 0, phase: "active" })

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 0, phase: "active" })
    expect(await rounds(stub)).toHaveLength(0)
    expect((await goalRows(stub)).filter((row) => row.status === "pending")).toHaveLength(1)
    expect(goal.id).toBeDefined()
  })

  it("withdraws a queued round after its row restarts", async () => {
    const { stub } = await setup()
    respond([
      fauxAssistantMessage("noted"),
      fauxAssistantMessage("human replied"),
      fauxAssistantMessage("unused round"),
    ])
    const goal = await createGoal(stub, 5)
    await turn(stub, `restart-start-${crypto.randomUUID()}`)
    expect(await pendingGoalCommands(stub)).toHaveLength(1)

    await setRow(stub, "goal-rounds", false)
    await setRow(stub, "goal-rounds", true)

    const sent = await cmd(stub, `human-${crypto.randomUUID()}`, "message.send", { text: "wait for me" })
    expect(sent.ok).toBe(true)
    expect(await goalRows(stub)).toEqual([])

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 0, phase: "active" })
    expect(await rounds(stub)).toHaveLength(0)
    expect(goal.id).toBeDefined()
  })

  it("does not continue after an eviction disarms the goal", async () => {
    const { stub, conversation } = await setup()
    respond([fauxAssistantMessage("before eviction"), fauxAssistantMessage("after eviction")])
    const goal = await createGoal(stub, 5)
    await turn(stub, `evict-start-${crypto.randomUUID()}`)
    expect(await goalRows(stub)).toHaveLength(1)

    await evictDurableObject(stub)
    await mount(stub)

    await eventually(stub, async (home: Home) => {
      const read = await home.loader.ctx.goals.get(conversation)
      return read?.id === goal.id && read.phase === "active" && read.activation === "disarmed"
    })

    await fire(stub)
    expect(await goalNow(stub)).toMatchObject({ rounds: 0, phase: "active", activation: "disarmed" })
    expect(await rounds(stub)).toHaveLength(0)
  })

  it("leaves the goal usable by hand when the row is disabled", async () => {
    const { stub } = await setup({ rounds: false })
    respond([fauxAssistantMessage("noted")])
    const goal = await createGoal(stub, 5)

    await turn(stub, `disabled-start-${crypto.randomUUID()}`)
    expect(await goalRows(stub)).toEqual([])
    expect(await goalNow(stub)).toMatchObject({ rounds: 0, phase: "active" })

    const paused = await pauseGoal(stub, goal.id, goal.revision)
    expect(paused).toMatchObject({ kind: "ok", goal: { phase: "paused", activation: "disarmed" } })
  })
})
