import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { AutomationView } from "./automations.ts"

const BATCHED_WRITE_BOUND = 2
const BATCHED_READ_BOUND = 8
const DUE_READ_BOUND = 0

type Stub = ReturnType<typeof fresh>

const billed = (stub: Stub): Promise<{ written: number; read: number }> =>
  runInDurableObject(stub, (home: Home) => {
    const meter = home.meter()
    return {
      written: meter.sql.writes + meter.kv.writes + meter.alarm.writes,
      read: meter.sql.reads + meter.kv.reads + meter.alarm.reads,
    }
  })

describe("automations, in what the platform bills", () => {
  it("collects a webhook delivery into a batch and answers the clock from memory", async () => {
    const stub = fresh()
    const created = await cmd(stub, "c1", "project.create", { slug: "cost", name: "cost" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const automation = await cmd(stub, "c2", "automation.create", {
      title: "Digest",
      prompt: "Summarize",
      project: "cost",
      triggers: [{ kind: "webhook", rules: [{ groupBy: ["repo"], quietSeconds: 600 }] }],
    })
    expect(automation.ok, JSON.stringify(automation)).toBe(true)
    const trigger = (automation.result as AutomationView).triggers[0]
    if (trigger?.kind !== "webhook") throw new Error("no webhook trigger")
    const post = (body: unknown) =>
      stub.fetch(new Request(`https://ingle.test${trigger.path}`, { method: "POST", body: JSON.stringify(body) }))

    expect((await post({ repo: "a" })).status).toBe(202)
    const before = await billed(stub)
    expect((await post({ repo: "a" })).status).toBe(202)
    const after = await billed(stub)
    expect(after.written - before.written).toBeLessThanOrEqual(BATCHED_WRITE_BOUND)
    expect(after.read - before.read).toBeLessThanOrEqual(BATCHED_READ_BOUND)

    await runInDurableObject(stub, (home: Home) => home.loader.ctx.automations.due())
    const cached = await billed(stub)
    await runInDurableObject(stub, async (home: Home) => {
      await home.loader.ctx.automations.due()
      await home.loader.ctx.automations.fire(Date.now())
    })
    expect((await billed(stub)).read - cached.read).toBeLessThanOrEqual(DUE_READ_BOUND)
  })
})
