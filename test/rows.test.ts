import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { startMeter } from "./rows.ts"
import { cmd, eventually, fresh } from "./support.ts"
import { FAUX_MODEL, type Home } from "./worker.ts"

const context = BACKGROUND_CONTEXT

async function fireNow(stub: ReturnType<typeof fresh>): Promise<void> {
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  await runDurableObjectAlarm(stub)
}

const idle = (stub: ReturnType<typeof fresh>): Promise<void> =>
  runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))

const inboundDone = async (home: Home): Promise<boolean> => {
  const rows = await home.db.all<{ status: string }>("SELECT status FROM inbound")
  return rows.length > 0 && rows.every((row) => row.status === "done")
}

const BASELINE = { written: 89, read: 126 }
const TOLERANCE = 5

/**
 * The before/after instrument for the write-cost work. It measures what Cloudflare bills — rows
 * written and read, index rows included — instead of `total_changes()`, which counts table rows
 * only. It fails, with the measured numbers, when the billed SQL rows move more than `TOLERANCE`
 * away from `BASELINE`, so a real saving or regression cannot land silently. Update `BASELINE` when
 * a move is intended; that failure is also how the new number is read, since Vitest hides console
 * output for a passing test.
 */
describe("billed rows", () => {
  it("reports what one message and one reply cost", async () => {
    const stub = fresh()
    const meter = await startMeter(stub)
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer", "another answer"])
      await home.chooseModel(FAUX_MODEL)
    })

    for (const [index, text] of ["hello", "again"].entries()) {
      await meter.reset()
      const sent = await cmd(stub, `rows-message-${index}`, "message.send", { text })
      expect(sent.ok, JSON.stringify(sent)).toBe(true)
      await fireNow(stub)
      await eventually(stub, (home: Home) => inboundDone(home))
      await idle(stub)
      const billed = await meter.snapshot()
      console.warn(`message ${index + 1} and its reply: ${JSON.stringify(billed)}`)
      expect(billed.written).toBeGreaterThan(0)
      expect(billed.sql.written + billed.kv.written + billed.alarm.writes).toBe(billed.written)
      const moved = `billed SQL rows moved from ${BASELINE.written}/${BASELINE.read}: ${JSON.stringify(billed)}`
      expect(Math.abs(billed.sql.written - BASELINE.written), moved).toBeLessThanOrEqual(TOLERANCE)
      expect(Math.abs(billed.sql.read - BASELINE.read), moved).toBeLessThanOrEqual(TOLERANCE)
    }
  })
})
