import type { Wake } from "@earendil-works/pi-durable"
import { Context } from "@deepseek-ai/cordis"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { Clock } from "./clock.ts"
import type { Runtime } from "./types.ts"

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

  it("arms a recovery alarm within two minutes while a run is active", async () => {
    const stub = await boot()
    const now = Date.now()
    await runInDurableObject(stub, async (home: Home, state) => {
      home.loader.ctx.clock.fired()
      await state.storage.deleteAlarm()
      await home.arm({ active: true })
    })
    const at = await runInDurableObject(stub, (_home: Home, state) => state.storage.getAlarm())
    expect(at).not.toBeNull()
    expect((at ?? 0) - now).toBeLessThanOrEqual(120_000)
    expect((at ?? 0) - now).toBeGreaterThan(0)
  })

  it("keeps a nearer deadline when a run is active", async () => {
    const stub = await boot()
    const soon = Date.now() + 5_000
    await arm(stub, { active: true, at: soon })
    const at = await runInDurableObject(stub, (_home: Home, state) => state.storage.getAlarm())
    expect(at).toBe(soon)
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

  it("runs every timer when one throws, and still arms at the end of the alarm", async () => {
    const stub = await boot()
    const fired: string[] = []
    await runInDurableObject(stub, async (home: Home) => {
      home.loader.ctx.clock.timers.add({
        due: async () => undefined,
        fire: async () => {
          fired.push("throwing")
          throw new Error("timer exploded")
        },
      })
      home.loader.ctx.clock.timers.add({ due: async () => undefined, fire: async () => void fired.push("after") })
      await home.alarm()
    })
    expect(fired).toEqual(["throwing", "after"])
  })

  it("keeps the other deadlines when one timer's due throws", async () => {
    const stub = await boot()
    const at = Date.now() + 5_000
    await runInDurableObject(stub, async (home: Home, state) => {
      home.loader.ctx.clock.timers.add({
        due: async () => {
          throw new Error("due exploded")
        },
        fire: async () => undefined,
      })
      home.loader.ctx.clock.timers.add({ due: async () => at, fire: async () => undefined })
      home.loader.ctx.clock.fired()
      await state.storage.deleteAlarm()
      await home.arm({ active: false })
    })
    expect(await runInDurableObject(stub, (_home: Home, state) => state.storage.getAlarm())).toBe(at)
  })

  it("tells a caller when the alarm could not be written", async () => {
    const root = new Context()
    let aborted: string | undefined
    root.provide("host", {
      state: {
        storage: {
          getAlarm: async () => null,
          setAlarm: async () => {
            throw new Error("cannot write the alarm")
          },
          deleteAlarm: async () => undefined,
        },
      },
      abort: (reason: string) => {
        aborted = reason
      },
    } as unknown as Runtime)
    await root.plugin(Clock)
    const clock = root.get("clock")
    if (clock === undefined) throw new Error("the clock did not start")
    await expect(clock.arm({ active: true, at: Date.now() + 1_000 })).rejects.toThrow("cannot write the alarm")
    expect(aborted).toBe("alarm write failed")
  })
})
