import { type Context, Service } from "@deepseek-ai/cordis"
import type { Wake } from "@earendil-works/pi-durable"

export const HEARTBEAT_MS = 60_000

export type Timer = {
  due(): Promise<number | undefined>
  fire(now: number): Promise<void>
}

type Batch = { wake: Wake | undefined; waiters: (() => void)[] }

/**
 * One alarm for every deadline: pi's next wake and each timer's due time.
 *
 * Arms coalesce: a call that arrives while one is running joins the next round, so a burst of wake changes costs one
 * round, not one per call. The alarm is one row that moves only when the earliest deadline moves, and is deleted when
 * an idle home has none. There is no fixed heartbeat: a run in progress holds the alarm it started with, and an
 * eviction during one is recovered by the turn's own retry rather than by a periodic wake. `fired()` marks the alarm
 * the runtime consumed, so the next arm knows it has to set a new one.
 */
export class Clock extends Service {
  static readonly inject = ["host"]

  readonly timers = new Set<Timer>()

  /** The alarm this process last wrote, `null` for none, `undefined` until the first read. */
  #armed: number | null | undefined = undefined
  #next: Batch | undefined
  #running = false

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

  /**
   * The runtime ran the alarm and cleared it: the next arm writes a new one.
   *
   * `arm` and `fired` are properties, not methods: the plugin layer hands out a proxy of this service whose methods run
   * with that proxy as `this`, and a private field cannot be read through it.
   */
  readonly fired = (): void => {
    this.#armed = null
  }

  readonly arm = (wake?: Wake): Promise<void> => {
    const settled = Promise.withResolvers<void>()
    const queued = this.#next
    if (queued !== undefined) {
      if (wake !== undefined) queued.wake = wake
      queued.waiters.push(settled.resolve)
      return settled.promise
    }
    this.#next = { wake, waiters: [settled.resolve] }
    if (!this.#running) {
      this.#running = true
      void this.#drain()
    }
    return settled.promise
  }

  async fire(now: number): Promise<void> {
    for (const timer of Array.from(this.timers)) await timer.fire(now)
  }

  async #drain(): Promise<void> {
    try {
      for (;;) {
        const batch = this.#next
        if (batch === undefined) break
        this.#next = undefined
        try {
          await this.#apply(batch.wake)
        } catch {
          this.ctx.host.abort("alarm write failed")
        }
        for (const resolve of batch.waiters) resolve()
      }
    } finally {
      this.#running = false
      if (this.#next !== undefined) {
        this.#running = true
        void this.#drain()
      }
    }
  }

  async #apply(wake: Wake | undefined): Promise<void> {
    const harness = this.ctx.get("harness")
    const current = wake ?? (harness === undefined ? { active: true } : { ...harness.wake(), active: true })
    const owned = harness === undefined ? [] : await Promise.all([...this.timers].map((timer) => timer.due()))
    const due = [current.at, ...owned].filter((at): at is number => at !== undefined)
    const storage = this.ctx.host.state.storage
    if (this.#armed === undefined) this.#armed = await storage.getAlarm()
    const deadline = due.length === 0 ? undefined : Math.min(...due)
    let at = deadline
    if (current.active) {
      // pi's contract: a process that dies while work is running must be woken again. Fold a recovery horizon into the
      // minimum only when the alarm is not already inside it, so it never pushes a nearer deadline later and a standing
      // recovery alarm is not rewritten on every event.
      const horizon = Date.now() + HEARTBEAT_MS
      if (this.#armed !== null && this.#armed <= horizon) {
        if (deadline === undefined || this.#armed <= deadline) return
        at = deadline
      } else at = deadline === undefined ? horizon : Math.min(deadline, horizon)
    }
    if (at === undefined) {
      if (this.#armed === null) return
      await storage.deleteAlarm()
      this.#armed = null
      return
    }
    // One deadline, one row: the alarm moves only when the earliest deadline moves.
    if (this.#armed === at) return
    await storage.setAlarm(at)
    this.#armed = at
  }
}
