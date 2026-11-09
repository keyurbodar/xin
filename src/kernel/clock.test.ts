import type { Wake } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>

const arm = (stub: Stub, wake: Wake): Promise<void> => runInDurableObject(stub, (home: Home) => home.arm(wake))

const alarmWrites = (stub: Stub): Promise<number> => runInDurableObject(stub, (home: Home) => home.meter().alarm.writes)

async function boot(): Promise<Stub> {
  const stub = fresh()
  await runInDurableObject(stub, (home: Home) => home.root())
  return stub
}

describe("the alarm", () => {
  it("is not written again while its deadline stands", async () => {
    const stub = await boot()
    const wake: Wake = { active: true, at: Date.now() + 5_000 }
    await arm(stub, wake)
    const written = await alarmWrites(stub)
    await arm(stub, wake)
    await arm(stub, wake)
    expect(await alarmWrites(stub)).toBe(written)
  })

  it("is written when a deadline comes sooner", async () => {
    const stub = await boot()
    await arm(stub, { active: true, at: Date.now() + 30_000 })
    const written = await alarmWrites(stub)
    await arm(stub, { active: true, at: Date.now() + 1_000 })
    expect(await alarmWrites(stub)).toBe(written + 1)
  })

  it("is written after the runtime consumed it", async () => {
    const stub = await boot()
    const wake: Wake = { active: true, at: Date.now() + 5_000 }
    await arm(stub, wake)
    await runInDurableObject(stub, (home: Home) => {
      home.loader.ctx.clock.fired()
    })
    const written = await alarmWrites(stub)
    await arm(stub, wake)
    expect(await alarmWrites(stub)).toBe(written + 1)
  })
})
