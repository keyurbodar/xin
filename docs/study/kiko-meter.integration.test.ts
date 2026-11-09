/**
 * Not part of Xin's build (nothing includes `docs/`). This is the probe behind the numbers in
 * `docs/study/kiko-durable-objects.md`, kept so the Kiko side can be re-measured.
 *
 * Copy to `kiko/apps/server/integration/kiko-meter.integration.test.ts`, then from
 * `kiko/apps/server`:
 *
 *   bunx vitest run --project worker integration/kiko-meter.integration.test.ts --silent=false
 *
 * Results at Kiko 82906df0, Workers Free plan limits 100k rows written / 5M rows read per day:
 *
 *   one warm prompt, 26 messages   6 writes   4,796 reads
 *   one warm prompt, 22 messages   6 writes   4,094 reads
 *   one warm prompt, 324 messages  8 writes 331,316 reads
 *   first room.search              2 writes     100 reads
 *   second room.search             0 writes      75 reads
 *   fresh socket, full snapshot    0 writes     698 reads
 *   three idle seconds             0 writes       0 reads
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { connect, type Counters, idle, type Meter, type Owner, type Room, signIn } from "./owner"
import { localWorker } from "./worker"

const FILLER = 150

const top = (meter: Meter, key: "rowsWritten" | "rowsRead", n = 8) =>
  (meter.statements ?? [])
    .slice()
    .sort((a, b) => b[key] - a[key])
    .slice(0, n)
    .filter((row) => row[key] > 0)
    .map((row) => `${String(row[key]).padStart(6)}  ${row.sql.slice(0, 150)}`)
    .join("\n")

const sums = (counters: Counters) => {
  const sum = (suffix: string) =>
    Object.entries(counters).reduce((total, [key, value]) => (key.endsWith(suffix) ? total + value : total), 0)
  return {
    writes: sum("sqlRowsWritten") + sum("kvKeysPut") + sum(".alarmWrites"),
    reads: sum("rowsRead"),
  }
}

const reset = (owner: Owner) => owner.post("api/dev/stats/reset", {})

const prompt = (room: Room, text: string) =>
  Effect.gen(function* () {
    const mark = yield* room.mark()
    yield* room.send(`[reply] ${text}`)
    yield* room.untilMessage((messages) => messages.some((message) => message.text === text))
    yield* room.untilIdleAfter(mark)
    yield* idle(150)
  })

const report = (name: string, meter: Meter) => {
  const s = sums(meter.counters)
  console.log(`\n### ${name}: ${s.writes} writes, ${s.reads} reads`)
  console.log(`-- top writes --\n${top(meter, "rowsWritten")}`)
  console.log(`-- top reads --\n${top(meter, "rowsRead")}`)
  return s
}

describe.concurrent("kiko meter", () => {
  it.live("measures a prompt, search, snapshot, catch-up and growth", () =>
    Effect.gen(function* () {
      const worker = yield* localWorker
      const owner = yield* signIn(worker.url, "kiko-meter")
      const session = yield* connect(worker.url, owner.token)
      const room = yield* session.newRoom("kiko meter")
      yield* owner.post("api/dev/agent/fake", { roomId: room.roomId })
      yield* prompt(room, "warm")
      for (let index = 0; index < 9; index++) yield* prompt(room, `filler ${index}`)

      yield* reset(owner)
      yield* prompt(room, "measured prompt")
      yield* idle(400)
      const small = report("one prompt", yield* owner.meter())

      yield* reset(owner)
      const first = yield* session.client["room.search"]({ roomId: room.roomId, query: "filler" })
      yield* idle(200)
      console.log(`search hits: ${first.results.length}`)
      report("first room.search", yield* owner.meter())

      yield* reset(owner)
      const second = yield* session.client["room.search"]({ roomId: room.roomId, query: "filler" })
      yield* idle(200)
      console.log(`search hits: ${second.results.length}`)
      report("second room.search", yield* owner.meter())

      yield* reset(owner)
      const fresh = yield* connect(worker.url, owner.token)
      yield* fresh.openRoom(room.roomId)
      yield* idle(200)
      report("fresh socket, snapshot", yield* owner.meter())

      yield* reset(owner)
      const last = (yield* room.messages()).at(-1)?.seq ?? 0
      yield* fresh.openRoom(room.roomId, last)
      yield* idle(200)
      report("second socket, catch-up", yield* owner.meter())

      yield* reset(owner)
      yield* idle(3_000)
      report("three idle seconds", yield* owner.meter())

      for (let index = 0; index < FILLER; index++) yield* prompt(room, `filler ${index}`)
      yield* reset(owner)
      yield* prompt(room, "big prompt")
      yield* idle(400)
      const big = report("one prompt in a long room", yield* owner.meter())
      console.log(`\nreads per prompt: ${small.reads} at ~22 messages, ${big.reads} at ~${(yield* room.messages()).length}`)
      assert.ok(big.reads > small.reads)
    }).pipe(Effect.scoped),
  )
})
