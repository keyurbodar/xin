import type { LuaMeter } from "fengari/src/lua.js"

export const MAX_ALLOCATION = (1 << 20) + 64
export const SMALL_ALLOCATION = 4096

export type Allowance = { readonly bytes: number; readonly entries: number }

/** One call's allowance in the browser frame, where a long-lived visual renders forever. */
export const PER_CALL: Allowance = { bytes: 32 << 20, entries: 100_000 }
/** The whole of a DO check (setup, render, every draw and handler on one state), which must fit the isolate's 128 MB with room to spare. */
export const PER_CHECK: Allowance = { bytes: 48 << 20, entries: 300_000 }

const BYTES_FAILURE =
  "the script built too much text (repeated `..` in a loop copies the whole string each time; collect parts in a table and use table.concat)"
const ENTRIES_FAILURE = "the script filled tables with too many entries; summarize the data first"

/**
 * A Lua state's memory allowance, called by fengari itself (patches/fengari@0.1.5.patch) before every string buffer, string and table entry it makes.
 * `failure` is sticky: once set, the instruction hook and the pcall wrappers raise it again until the call returns, so `pcall` cannot swallow it.
 */
export class Meter implements LuaMeter {
  failure: string | undefined = undefined
  private bytes = 0
  private entries = 0

  constructor(
    private readonly allowance: Allowance,
    private readonly scope: "call" | "lifetime",
  ) {}

  /** Start a call: clear the failure, and the counts too when the allowance is per call. */
  reset(): void {
    this.failure = undefined
    if (this.scope === "lifetime") return
    this.bytes = 0
    this.entries = 0
  }

  fail(failure: string): void {
    this.failure ??= failure
  }

  buffer(size: number): void {
    this.allocate(size)
  }

  string(size: number): void {
    this.allocate(size)
  }

  entry(): void {
    if (this.failure !== undefined) return
    this.entries += 1
    if (this.entries > this.allowance.entries) this.refuse(ENTRIES_FAILURE)
  }

  private allocate(size: number): void {
    if (this.failure !== undefined) {
      if (size <= SMALL_ALLOCATION) return
      throw new RangeError(this.failure)
    }
    if (size > MAX_ALLOCATION) this.refuse("the script built a string over 1 MB")
    this.bytes += size
    if (this.bytes > this.allowance.bytes) this.refuse(BYTES_FAILURE)
  }

  private refuse(failure: string): never {
    this.failure = failure
    throw new RangeError(failure)
  }
}
