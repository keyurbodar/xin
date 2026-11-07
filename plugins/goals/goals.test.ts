import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import type { Goal } from "../../src/contracts/goals.ts"
import { cmd, fresh, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { createGoals } from "./goals.ts"
import * as goalsRow from "./index.ts"
import manifest from "./package.json"

type Ack = { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string } }

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

async function mount(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    if (home.loader.ctx.get("goals") !== undefined) return
    if (home.loader.rows().some((row) => row.id === "goals")) return
    await home.loader.ctx.plugin(goalsRow)
  })
}

async function setup(): Promise<{ stub: Stub; root: number }> {
  const stub = fresh()
  await mount(stub)
  const root = await runInDurableObject(stub, async (home: Home) => Number((await home.root()).id))
  return { stub, root }
}

const set = (stub: Stub, root: number, args: Record<string, unknown>): Promise<Ack> =>
  cmd(stub, `goal-set-${crypto.randomUUID()}`, "goal.set", { conversation: root, ...args })

const get = (stub: Stub, root: number): Promise<Ack> =>
  cmd(stub, `goal-get-${crypto.randomUUID()}`, "goal.get", { conversation: root })

const create = (stub: Stub, root: number, objective = "ship the release"): Promise<Ack> =>
  set(stub, root, { action: "create", objective })

const goalOf = (ack: Ack): Record<string, unknown> => record(record(ack.result).goal)

const stored = (stub: Stub, root: number): Promise<Goal | undefined> =>
  runInDurableObject(stub, (_home: Home, state: DurableObjectState) => state.storage.kv.get<Goal>(`goal.${root}`))

describe("row", () => {
  it("declares the goals, tool-goals and goal-rounds rows in one bundle", () => {
    expect(manifest.xin.plugins.goals).toMatchObject({ module: "./index.ts" })
    expect(manifest.xin.plugins["tool-goals"]).toMatchObject({ module: "./tools.ts" })
    expect(manifest.xin.plugins["goal-rounds"]).toMatchObject({ module: "./rounds.ts" })
    expect(manifest.xin.bundle).toEqual([
      { id: "goals", plugin: "goals" },
      { id: "tool-goals", plugin: "tool-goals" },
      { id: "goal-rounds", plugin: "goal-rounds" },
    ])
  })

  it("rejects a defaultMaxRounds that is not a positive safe integer", async () => {
    const stub = fresh()
    const failure = await runInDurableObject(stub, async (home: Home) => {
      try {
        await home.loader.ctx.plugin(goalsRow, { defaultMaxRounds: 0 })
        return "loaded"
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    expect(failure).not.toBe("loaded")
  })
})

describe("lifecycle", () => {
  it("creates one armed active goal in the conversation's kv", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root, "  ship the release  ")

    expect(created.ok).toBe(true)
    expect(goalOf(created)).toMatchObject({
      revision: 1,
      objective: "ship the release",
      phase: "active",
      rounds: 0,
      maxRounds: 256,
      activation: "armed",
    })
    expect(String(goalOf(created).id)).toMatch(/^g[0-9a-f]{12}$/)

    const kv = await stored(stub, root)
    expect(kv).toMatchObject({ id: goalOf(created).id, revision: 1, objective: "ship the release", rounds: 0 })

    const read = await get(stub, root)
    expect(goalOf(read)).toMatchObject({ id: goalOf(created).id, activation: "armed" })
  })

  it("edits the objective and cap without changing the phase", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    const edited = await set(stub, root, {
      action: "edit",
      id: goalOf(created).id,
      revision: 1,
      objective: "ship two releases",
      maxRounds: 4,
    })

    expect(goalOf(edited)).toMatchObject({
      revision: 2,
      objective: "ship two releases",
      phase: "active",
      rounds: 0,
      maxRounds: 4,
    })
    expect(await stored(stub, root)).toMatchObject({ revision: 2, maxRounds: 4 })
  })

  it("pauses disarmed and resumes armed, clearing a blocker", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    const id = goalOf(created).id

    const paused = await set(stub, root, { action: "pause", id, revision: 1 })
    expect(goalOf(paused)).toMatchObject({ revision: 2, phase: "paused", activation: "disarmed" })

    const resumed = await set(stub, root, { action: "resume", id, revision: 2 })
    expect(goalOf(resumed)).toMatchObject({ revision: 3, phase: "active", activation: "armed" })

    const blocked = await set(stub, root, { action: "block", id, revision: 3, reason: "no credential" })
    expect(goalOf(blocked)).toMatchObject({
      revision: 4,
      phase: "blocked",
      activation: "disarmed",
      blocker: { code: "model-reported", reason: "no credential" },
    })

    const rearmed = await set(stub, root, { action: "resume", id, revision: 4 })
    expect(goalOf(rearmed)).toMatchObject({ revision: 5, phase: "active", activation: "armed" })
    expect(goalOf(rearmed).blocker).toBeUndefined()
  })

  it("completes disarmed and lets a completed goal be replaced", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    const completed = await set(stub, root, { action: "complete", id: goalOf(created).id, revision: 1 })

    expect(goalOf(completed)).toMatchObject({ phase: "complete", activation: "disarmed" })

    const replaced = await create(stub, root, "next objective")
    expect(replaced.ok).toBe(true)
    expect(goalOf(replaced)).toMatchObject({ revision: 1, objective: "next objective", phase: "active" })
    expect(goalOf(replaced).id).not.toBe(goalOf(created).id)
  })

  it("requires a non-empty reason to block", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    const id = goalOf(created).id

    const empty = await set(stub, root, { action: "block", id, revision: 1, reason: "   " })
    expect(empty.ok).toBe(false)
    expect(empty.error?.code).toBe("bad_args")
    expect(await stored(stub, root)).toMatchObject({ phase: "active", revision: 1 })

    await set(stub, root, { action: "pause", id, revision: 1 })
    const paused = await set(stub, root, { action: "block", id, revision: 2, reason: "stuck" })
    expect(paused.ok).toBe(false)
  })

  it("clears the goal and its kv entry", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    const cleared = await set(stub, root, { action: "clear", id: goalOf(created).id, revision: 1 })

    expect(cleared.ok).toBe(true)
    expect(goalOf(cleared)).toEqual({})
    expect(await stored(stub, root)).toBeUndefined()

    const again = await create(stub, root, "fresh")
    expect(again.ok).toBe(true)
  })

  it("answers a stale revision with the current goal and changes nothing", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    await set(stub, root, { action: "pause", id: goalOf(created).id, revision: 1 })

    const stale = await set(stub, root, { action: "edit", id: goalOf(created).id, revision: 1, objective: "other" })
    expect(record(stale.result).kind).toBe("stale_revision")
    expect(goalOf(stale)).toMatchObject({ revision: 2, phase: "paused", objective: "ship the release" })
    expect(await stored(stub, root)).toMatchObject({ revision: 2, objective: "ship the release" })
  })

  it("refuses a second goal until the first is finished or cleared", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    const id = goalOf(created).id

    const duplicate = await create(stub, root, "another")
    expect(record(duplicate.result).kind).toBe("goal_exists")
    expect(goalOf(duplicate)).toMatchObject({ id, phase: "active" })

    await set(stub, root, { action: "pause", id, revision: 1 })
    expect(record((await create(stub, root, "another")).result).kind).toBe("goal_exists")

    await set(stub, root, { action: "resume", id, revision: 2 })
    await set(stub, root, { action: "block", id, revision: 3, reason: "stuck" })
    expect(record((await create(stub, root, "another")).result).kind).toBe("goal_exists")
  })

  it("starts disarmed after a new instance", async () => {
    const { stub, root } = await setup()
    const created = await create(stub, root)
    expect(goalOf(created).activation).toBe("armed")

    await evictDurableObject(stub)
    await mount(stub)

    const read = await get(stub, root)
    expect(goalOf(read)).toMatchObject({ id: goalOf(created).id, phase: "active", activation: "disarmed" })
  })

  it("uses the configured default cap", async () => {
    const stub = fresh()
    const created = await runInDurableObject(stub, async (_home: Home, state: DurableObjectState) =>
      createGoals({ kv: state.storage.kv, defaultMaxRounds: 4 }).set({
        conversation: 1 as ConversationId,
        action: "create",
        objective: "ship the release",
      }),
    )
    expect(created).toMatchObject({ kind: "ok", goal: { maxRounds: 4 } })
  })

  it("answers no goal before a create", async () => {
    const { stub, root } = await setup()
    expect(record((await get(stub, root)).result).goal).toBeNull()
  })

  it("stores the goal under goal.<conversation> in the Durable Object kv", async () => {
    const { stub, root } = await setup()
    await create(stub, root)
    const rows = await runInDurableObject(stub, (_home: Home, state: DurableObjectState) =>
      [...state.storage.kv.list({ prefix: "goal." })].map(([key]) => key),
    )
    expect(rows).toEqual([`goal.${root}`])
  })
})
