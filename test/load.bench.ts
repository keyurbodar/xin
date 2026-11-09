import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { defaultSpaceOf, ThreadDoc } from "../src/contracts/threaddoc.ts"
import { WorkspaceDoc } from "../src/contracts/workspace.ts"
import { cmd, fresh } from "./support.ts"
import { FAUX_MODEL, type Home } from "./worker.ts"
import type { Sample } from "./meter.ts"

const CONTEXT = BACKGROUND_CONTEXT
const THREADS = 100
const TURNS = 3
const IDLE_ALARMS = 5
const COLD_TURNS = 1
const FILL_TARGET = 250

type Counts = { readonly calls: number; readonly reads: number; readonly writes: number }
type Stub = ReturnType<typeof fresh>

type Delta = { readonly sql: Counts; readonly kv: Counts; readonly alarm: Counts; readonly total: Counts }

const zero: Counts = { calls: 0, reads: 0, writes: 0 }

const add = (left: Counts, right: Counts): Counts => ({
  calls: left.calls + right.calls,
  reads: left.reads + right.reads,
  writes: left.writes + right.writes,
})

const sub = (left: Counts, right: Counts): Counts => ({
  calls: left.calls - right.calls,
  reads: left.reads - right.reads,
  writes: left.writes - right.writes,
})

const total = (sample: Sample): Counts => add(add(sample.sql, sample.kv), sample.alarm)

const delta = (after: Sample, before: Sample): Delta => ({
  sql: sub(after.sql, before.sql),
  kv: sub(after.kv, before.kv),
  alarm: sub(after.alarm, before.alarm),
  total: sub(total(after), total(before)),
})

const meter = (stub: Stub): Promise<Sample> => runInDurableObject(stub, (home: Home) => home.meter())

const per = (counts: Counts, divisor: number): Counts => ({
  calls: Math.round(counts.calls / divisor),
  reads: Math.round(counts.reads / divisor),
  writes: Math.round(counts.writes / divisor),
})

const round = (counts: Counts): Counts => ({
  calls: Math.round(counts.calls),
  reads: Math.round(counts.reads),
  writes: Math.round(counts.writes),
})

const idle = (stub: Stub): Promise<void> => runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(CONTEXT))

const journalRows = (stub: Stub): Promise<number> =>
  runInDurableObject(stub, (_home: Home, state) =>
    Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM pi_journal").one().n),
  )

type Window = { readonly plumbing: Counts; readonly harness: Counts }

/** The synthetic fire-at write is test plumbing, not a message's cost; the alarm window is the harness's. */
async function fireNow(stub: Stub): Promise<Window> {
  const before = await meter(stub)
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  const plumbing = delta(await meter(stub), before).total
  const alarmBefore = await meter(stub)
  await runDurableObjectAlarm(stub)
  const harness = delta(await meter(stub), alarmBefore).total
  return { plumbing, harness }
}

async function turn(stub: Stub, id: number, text: string, seq: number): Promise<Window & { readonly sent: boolean }> {
  const sent = await cmd(stub, `load-${id}-${seq}`, "message.send", { conv: id, text })
  const window = await fireNow(stub)
  await idle(stub)
  return { ...window, sent: sent.ok }
}

function top(record: Record<string, Counts>, key: "reads" | "writes", count: number): [string, string][] {
  return Object.entries(record)
    .filter(([, counts]) => counts[key] > 0)
    .toSorted((left, right) => right[1][key] - left[1][key])
    .slice(0, count)
    .map(([name, counts]) => [name, `${counts.calls}c ${counts.reads}r ${counts.writes}w`])
}

describe("load", () => {
  it("measures the Durable Object reads and writes of many threads", async () => {
    const stub = fresh()

    // Boot: construct the Home and open the root conversation.
    await runInDurableObject(stub, async (home: Home) => {
      await home.root()
    })
    const boot = total(await meter(stub))

    // Setup: one project, then `THREADS` conversations that look like delegated threads.
    await runInDurableObject(stub, (home: Home) => home.meterLabel("setup"))
    const setupBefore = await meter(stub)
    const created = await cmd(stub, "load-project", "project.create", { slug: "load", name: "load" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const projectId = (created.result as { id: string }).id
    const ids = await runInDurableObject(stub, async (home: Home) => {
      const list: number[] = []
      for (let index = 0; index < THREADS; index++) {
        const conversation = await home.harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL } },
          CONTEXT,
        )
        await home.harness.commit(async (tx) => {
          const thread = await tx.doc(ThreadDoc, conversation.id)
          thread.projectId = projectId
          thread.title = `thread ${index}`
          thread.role = "thread"
          thread.status = "working"
          thread.run = 1
          const workspace = await tx.doc(WorkspaceDoc)
          const spaceId = defaultSpaceOf(workspace, projectId)
          const space = spaceId === undefined ? undefined : workspace.spaces[spaceId]
          if (spaceId === undefined || space === undefined) throw new Error(`no space for project ${projectId}`)
          thread.spaceId = spaceId
          space.threadIds.push(conversation.id)
        }, CONTEXT)
        list.push(conversation.id)
      }
      return list
    })
    const setup = delta(await meter(stub), setupBefore)

    // Turns: every thread gets `TURNS` messages, alternating a plain reply and a two-tool reply.
    await runInDurableObject(stub, (home: Home) => home.meterLabel("turn"))
    const turnBefore = await meter(stub)
    let harness: Counts = zero
    let plumbing: Counts = zero
    let requests = 0
    for (let cycle = 0; cycle < TURNS; cycle++) {
      for (const [index, id] of ids.entries()) {
        const text = (cycle + index) % 2 === 0 ? "ping 2" : "ping 0"
        const result = await turn(stub, id, text, cycle * THREADS + index)
        expect(result.sent, `message to ${id} was refused`).toBe(true)
        harness = add(harness, result.harness)
        plumbing = add(plumbing, result.plumbing)
        requests += 1
      }
    }
    const turns = delta(await meter(stub), turnBefore)
    const productTurns = sub(turns.total, plumbing)
    const turnCount = THREADS * TURNS

    // Idle alarms: what one wake costs when no message is pending.
    await runInDurableObject(stub, (home: Home) => home.meterLabel("idle"))
    const idleBefore = await meter(stub)
    for (let index = 0; index < IDLE_ALARMS; index++) await runDurableObjectAlarm(stub).catch(() => undefined)
    const idleAlarm = delta(await meter(stub), idleBefore)

    // Cold turn: fill the journal towards a full checkpoint, then evict. A cold start near the checkpoint bound is the
    // worst case: it replays the most rows, and a small journal would make the number look better than the real one.
    await runInDurableObject(stub, (home: Home) => home.meterLabel("fill"))
    let filled = 0
    while ((await journalRows(stub)) < FILL_TARGET && filled < THREADS * 4) {
      const id = ids[filled % ids.length] ?? ids[0] ?? 0
      const result = await turn(stub, id, "ping 0", 30_000 + filled)
      expect(result.sent, `fill message to ${id} was refused`).toBe(true)
      filled += 1
    }
    const replayed = await journalRows(stub)
    await runInDurableObject(stub, (home: Home) => home.meterLabel("cold"))
    const beforeEvict = await meter(stub)
    await evictDurableObject(stub)
    // The first read of the meter rebuilds the Home, so it returns the boot cost and everything after it.
    const afterBoot = await meter(stub)
    const coldBoot = delta(afterBoot, beforeEvict).total
    const coldBefore = afterBoot
    const coldTurn = await turn(stub, ids[0] ?? 0, "ping 0", 20_000)
    expect(coldTurn.sent, "cold message was refused").toBe(true)
    requests += 1
    const cold = per(sub(delta(await meter(stub), coldBefore).total, coldTurn.plumbing), COLD_TURNS)

    const all = await meter(stub)
    const report = {
      threads: THREADS,
      turns: turnCount,
      boot: round(boot),
      setup: round(setup.total),
      setupPerThread: per(setup.total, THREADS),
      turnSql: turns.sql,
      turnKv: turns.kv,
      turnAlarm: turns.alarm,
      turnTotal: turns.total,
      turnPerThread: per(productTurns, THREADS),
      turnPerMessage: per(productTurns, turnCount),
      harnessPerTurn: per(harness, turnCount),
      idleAlarm: { ...idleAlarm, total: per(idleAlarm.total, IDLE_ALARMS) },
      coldTurn: cold,
      coldBoot,
      coldJournalRows: replayed,
      filled,
      requests,
      sql: round(all.sql),
      kv: round(all.kv),
      alarm: round(all.alarm),
      topWrites: top(all.statements, "writes", 40),
      topReads: top(all.statements, "reads", 10),
      topKeys: Object.entries(all.keys)
        .filter(([, counts]) => counts.reads > 0)
        .toSorted((left, right) => right[1].reads - left[1].reads)
        .slice(0, 15)
        .map(([name, counts]) => [name, `${counts.reads}r/${counts.writes}w`] as [string, string]),
    }
    // Bounds from the measurement below, on a tree with no other load: 100 threads, 300 messages, half of them with
    // two tool calls. Writes are ~9 in 10 rows from pi's own commits, so a Xin regression shows here in the small part.
    const within = (name: string, value: number, bound: number): void => {
      expect(value, `${name} is ${value}, over ${bound}\n${JSON.stringify(report, null, 2)}`).toBeLessThanOrEqual(bound)
    }
    expect(report.coldBoot.reads, "cold boot replay measured no reads").toBeGreaterThan(0)
    within("calls per message", report.turnPerMessage.calls, 75)
    within("writes per message", report.turnPerMessage.writes, 36)
    within("reads per message", report.turnPerMessage.reads, 64)
    within("calls per cold turn", report.coldTurn.calls, 200)
    within("reads per cold turn", report.coldTurn.reads, 104)
    within("writes per cold turn", report.coldTurn.writes, 64)
    within("reads per idle alarm", report.idleAlarm.total.reads, 20)
    within("writes per idle alarm", report.idleAlarm.total.writes, 3)
    within("harness reads per message", report.harnessPerTurn.reads, 40)
    within("harness writes per message", report.harnessPerTurn.writes, 24)
    within("cold boot reads", report.coldBoot.reads, 560)
  }, 900_000)
})
