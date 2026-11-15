import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M5_MODEL } from "../../test/plugins/m5.ts"
import { cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { AutomationDetail, AutomationView, RunView } from "./automations.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const project = created.result as { id: string; coordinatorId: number }
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M5_MODEL }, context)
  })
  return project
}

async function op<T>(stub: Stub, id: string, name: string, args: unknown): Promise<T> {
  const ack = await cmd(stub, id, name, args)
  expect(ack.ok, JSON.stringify(ack)).toBe(true)
  return ack.result as T
}

const hook = (stub: Stub, path: string, body: unknown, headers: Record<string, string> = {}) =>
  stub.fetch(new Request(`https://ingle.test${path}`, { method: "POST", body: JSON.stringify(body), headers }))

const detail = (stub: Stub, id: string): Promise<AutomationDetail> =>
  op<AutomationDetail>(stub, `get-${crypto.randomUUID()}`, "automation.get", { id })

const alarm = (stub: Stub): Promise<number | null> =>
  runInDurableObject(stub, (_home: Home, state: DurableObjectState) => state.storage.getAlarm())

describe("automations", () => {
  it("validates triggers and reports the next cron occurrence in its zone", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "cron")
    const created = await op<AutomationView>(stub, "a1", "automation.create", {
      title: "Morning digest",
      prompt: "Summarize overnight news",
      project: project.id,
      triggers: [{ kind: "schedule", cron: "30 9 * * 1-5", tz: "Asia/Kolkata" }],
    })
    const next = created.nextAt === null ? Number.NaN : Date.parse(created.nextAt)
    expect(new Date(next).getUTCHours() * 60 + new Date(next).getUTCMinutes()).toBe(4 * 60)
    expect([1, 2, 3, 4, 5]).toContain(new Date(next + 5.5 * 3_600_000).getUTCDay())

    const bad = await cmd(stub, "a2", "automation.create", {
      title: "x",
      prompt: "y",
      project: project.id,
      triggers: [{ kind: "schedule", cron: "61 * * * *" }],
    })
    expect(bad.ok).toBe(false)
    const zone = await cmd(stub, "a3", "automation.create", {
      title: "x",
      prompt: "y",
      project: project.id,
      triggers: [{ kind: "schedule", cron: "0 9 * * *", tz: "Mars/Olympus" }],
    })
    expect(zone.ok).toBe(false)
  })

  it("arms nothing while every automation is disabled or webhook-only", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "idle")
    await runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))
    const created = await op<AutomationView>(stub, "i1", "automation.create", {
      title: "Nightly",
      prompt: "check",
      project: project.id,
      triggers: [{ kind: "schedule", cron: "0 3 * * *" }],
    })
    expect(await runInDurableObject(stub, (home: Home) => home.loader.ctx.automations.due())).toBe(
      Date.parse(created.nextAt ?? ""),
    )
    const disabled = await op<AutomationView>(stub, "i2", "automation.update", { id: created.id, enabled: false })
    expect(disabled.nextAt).toBeNull()
    expect(await runInDurableObject(stub, (home: Home) => home.loader.ctx.automations.due())).toBeUndefined()
    await op(stub, "i3", "automation.create", {
      title: "Hook",
      prompt: "react",
      project: project.id,
      triggers: [{ kind: "webhook" }],
    })
    expect(await runInDurableObject(stub, (home: Home) => home.loader.ctx.automations.due())).toBeUndefined()
    const reenabled = await op<AutomationView>(stub, "i4", "automation.update", { id: created.id, enabled: true })
    expect(reenabled.nextAt).toBe(created.nextAt)
    expect(await alarm(stub)).not.toBeNull()
  })

  it("starts a fresh thread when a schedule comes due and records status, thread and cost", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "fire")
    const created = await op<AutomationView>(stub, "f1", "automation.create", {
      title: "Weekly review",
      prompt: "Review the week",
      project: project.id,
      triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
    })
    const trigger = created.triggers[0]?.id ?? ""
    await runInDurableObject(stub, async (home: Home) => {
      const engine = home.loader.ctx.automations
      await engine.fire(Date.parse(created.nextAt ?? "") + 1000)
    })
    await eventually(stub, async (home: Home) => {
      const [run] = await home.loader.ctx.automations.store.runs(created.id, 1)
      if (run?.status === "failed") throw new Error(run.error ?? "failed")
      return run?.status === "completed"
    })
    const after = await detail(stub, created.id)
    expect(after.runs).toHaveLength(1)
    const run = after.runs[0]
    expect(run).toMatchObject({ source: "schedule", status: "completed", triggerId: trigger })
    expect(run?.threadId).toEqual(expect.any(Number))
    expect(run?.cost).toEqual(expect.any(Number))
    expect(after.nextAt).not.toBeNull()
    expect(Date.parse(after.nextAt ?? "")).toBeGreaterThan(Date.now())

    await runInDurableObject(stub, async (home: Home) => {
      const engine = home.loader.ctx.automations
      await engine.fire(Date.parse(created.nextAt ?? "") + 2000)
      expect(await engine.store.runs(created.id, 10)).toHaveLength(1)
    })
  }, 30_000)

  it("runs a webhook delivery that matches its conditions and ignores one that does not", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "hook")
    const created = await op<AutomationView>(stub, "h1", "automation.create", {
      title: "Triage alerts",
      prompt: "Triage this alert",
      project: project.id,
      triggers: [{ kind: "webhook", contains: ["severity"], regex: "critical|high" }],
    })
    const trigger = created.triggers[0]
    if (trigger?.kind !== "webhook") throw new Error("no webhook trigger")
    expect(trigger.path).toMatch(/^\/hooks\/[A-Za-z0-9_-]{43}$/)

    expect((await hook(stub, "/hooks/not-a-secret", {})).status).toBe(404)
    const ignored = await hook(stub, trigger.path, { severity: "low" })
    expect(await ignored.json()).toEqual({ status: "ignored", reason: "conditions" })

    const accepted = await hook(stub, trigger.path, { severity: "critical", id: 7 }, { "idempotency-key": "d-1" })
    expect(accepted.status).toBe(202)
    const replay = await hook(stub, trigger.path, { severity: "critical", id: 7 }, { "idempotency-key": "d-1" })
    expect(replay.status).toBe(202)
    const runs = (await detail(stub, created.id)).runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ source: "webhook", inputs: 1 })
    expect(runs[0]?.input).toContain('"severity":"critical"')
    expect(runs[0]?.threadId).toEqual(expect.any(Number))
  }, 30_000)

  it("coalesces deliveries by rule, group and count, and closes a quiet batch on the clock", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "batch")
    const created = await op<AutomationView>(stub, "b1", "automation.create", {
      title: "CI digest",
      prompt: "Summarize these CI events",
      project: project.id,
      enabled: true,
      triggers: [
        {
          kind: "webhook",
          rules: [
            { when: { event: "push" }, groupBy: ["repo"], count: 2 },
            { when: { event: "check" }, quietSeconds: 60 },
          ],
        },
      ],
    })
    const trigger = created.triggers[0]
    if (trigger?.kind !== "webhook") throw new Error("no webhook trigger")
    const send = async (body: unknown) => (await hook(stub, trigger.path, body)).json<Record<string, unknown>>()

    expect(await send({ event: "push", repo: "a" })).toEqual({ status: "batched", count: 1 })
    expect(await send({ event: "push", repo: "b" })).toEqual({ status: "batched", count: 1 })
    expect(await send({ event: "push", repo: "a" })).toMatchObject({ status: "started" })
    expect(await send({ event: "check", repo: "a" })).toEqual({ status: "batched", count: 1 })
    expect(await send({ event: "other" })).toMatchObject({ status: "started" })

    let current = await detail(stub, created.id)
    expect(current.runs.map((run) => run.inputs).toSorted()).toEqual([1, 2])
    expect(current.batches.map((batch) => batch.group).toSorted()).toEqual(['["b"]', "[]"])

    const quiet = current.batches.find((batch) => batch.group === "[]")
    expect(await runInDurableObject(stub, (home: Home) => home.loader.ctx.automations.due())).toBe(
      Date.parse(quiet?.closeAt ?? ""),
    )
    await runInDurableObject(stub, (home: Home) =>
      home.loader.ctx.automations.fire(Date.parse(quiet?.closeAt ?? "") + 1),
    )
    current = await detail(stub, created.id)
    expect(current.runs).toHaveLength(3)
    expect(current.batches.map((batch) => batch.group)).toEqual(['["b"]'])
  }, 30_000)

  it("runs on demand into the same thread every time, and deletes with its history", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "same")
    const created = await op<AutomationView>(stub, "s1", "automation.create", {
      title: "Standup notes",
      prompt: "Write standup notes",
      project: project.id,
      target: { kind: "same" },
      triggers: [],
    })
    const first = await op<RunView>(stub, "s2", "automation.trigger", { id: created.id, input: "focus on infra" })
    expect(first).toMatchObject({ source: "manual", status: "running", inputs: 1 })
    await eventually(
      stub,
      async (home: Home) => (await home.loader.ctx.automations.store.run(first.id))?.status === "completed",
    )
    const second = await op<RunView>(stub, "s3", "automation.trigger", { id: created.id })
    expect(second.threadId).toBe(first.threadId)
    expect((await detail(stub, created.id)).threadId).toBe(first.threadId)

    const removed = await op<{ deleted: boolean }>(stub, "s4", "automation.delete", { id: created.id })
    expect(removed.deleted).toBe(true)
    expect((await cmd(stub, "s5", "automation.get", { id: created.id })).ok).toBe(false)
    expect(
      await runInDurableObject(stub, (home: Home) => home.loader.ctx.automations.store.run(first.id)),
    ).toBeUndefined()
  }, 30_000)

  it("needs a project for fresh threads", async () => {
    const stub = fresh()
    const rejected = await cmd(stub, "p1", "automation.create", {
      title: "x",
      prompt: "y",
      triggers: [{ kind: "once", at: new Date(Date.now() + 60_000).toISOString() }],
    })
    expect(rejected.ok).toBe(false)
  })
})
