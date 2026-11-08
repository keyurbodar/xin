import { type Context, Service } from "@deepseek-ai/cordis"
import type { Wake } from "@earendil-works/pi-durable"

export const HEARTBEAT_MS = 60_000

export type Timer = {
  due(): Promise<number | undefined>
  fire(now: number): Promise<void>
}

export class Clock extends Service {
  static readonly inject = ["host"]

  readonly timers = new Set<Timer>()

  constructor(ctx: Context) {
    super(ctx, "clock")
  }

  timer(timer: Timer): () => void {
    return this.ctx.effect(() => {
      this.timers.add(timer)
      return () => {
        this.timers.delete(timer)
      }
    }, "clock.timer")
  }

  async arm(wake?: Wake): Promise<void> {
    const harness = this.ctx.get("harness")
    const current = wake ?? (harness === undefined ? { active: true } : { ...harness.wake(), active: true })
    const heartbeat = current.active ? Date.now() + HEARTBEAT_MS : undefined
    const owned = harness === undefined ? [] : await Promise.all([...this.timers].map((timer) => timer.due()))
    const due = [heartbeat, current.at, ...owned].filter((at): at is number => at !== undefined)
    const storage = this.ctx.host.state.storage
    if (due.length === 0) await storage.deleteAlarm()
    else await storage.setAlarm(Math.min(...due))
  }

  async fire(now: number): Promise<void> {
    for (const timer of Array.from(this.timers)) await timer.fire(now)
  }
}
