import type { LuaMeter } from "fengari/src/lua.js"

export const MAX_ALLOCATION = (1 << 20) + 64
export const SMALL_ALLOCATION = 4096
export const MAX_STACK = 100_000
/** What fengari's objects really cost in the JS heap, measured as heap growth per object: a table holds two Maps, and a closure an array of upvalue cells. */
export const TABLE_BYTES = 640
export const CLOSURE_BYTES = 160
export const UPVALUE_BYTES = 96

export type Allowance = { readonly bytes: number; readonly entries: number }

/** One call's allowance in the browser frame, where a long-lived visual renders forever. */
export const PER_CALL: Allowance = { bytes: 32 << 20, entries: 100_000 }
/** The whole of a DO check (setup, render, every draw and handler on one state), which must fit the isolate's 128 MB with room to spare. */
export const PER_CHECK: Allowance = { bytes: 48 << 20, entries: 300_000 }

const BYTES_FAILURE =
  "the script built too much text (repeated `..` in a loop copies the whole string each time; collect parts in a table and use table.concat)"
const ENTRIES_FAILURE = "the script filled tables with too many entries; summarize the data first"
const OBJECTS_FAILURE = "the script made too many tables or functions; summarize the data first"
const TIME_FAILURE =
  "the script ran past its time budget (an endless loop, or too much work per render; precompute data at the top level)"

/**
 * A Lua state's allowance, called by fengari itself (patches/fengari@0.1.5.patch): memory before every string buffer, string, table, closure, table entry and stack growth (a table or closure charged its heap size, a closure per upvalue), and time for every thousand instructions and for every native loop (string.rep, pattern matching, plain find, string comparison, string.byte, utf8 scans, table shifts, unpack and sort comparisons, __index and __newindex chains), which the instruction hook cannot see.
 * A string is charged three times its length because fengari also builds a hex key for it when it is hashed or ordered.
 * `failure` is sticky: once set, the instruction hook and the pcall wrappers raise it again until the call returns, so `pcall` cannot swallow it.
 */
export class Meter implements LuaMeter {
  failure: string | undefined = undefined
  private bytes = 0
  private entries = 0
  private steps = 0
  private limit = 0

  constructor(
    private readonly allowance: Allowance,
    private readonly scope: "call" | "lifetime",
  ) {}

  /** Start a call with `steps` of time: clear the failure, and the memory counts too when the allowance is per call. */
  reset(steps: number): void {
    this.failure = undefined
    this.steps = 0
    this.limit = steps
    if (this.scope === "lifetime") return
    this.bytes = 0
    this.entries = 0
  }

  buffer(size: number): void {
    this.allocate(size)
  }

  string(size: number): void {
    this.allocate(size, 3)
  }

  stack(slots: number): void {
    if (this.failure !== undefined) throw new RangeError(this.failure)
    if (slots > MAX_STACK) this.refuse("the script nested calls or returned values too deeply")
  }

  /** Spend time without throwing, for the instruction hook, which raises the failure as a Lua error itself. */
  tick(count: number): string | undefined {
    if (this.failure !== undefined) return this.failure
    this.steps += count
    if (this.steps > this.limit) this.failure = TIME_FAILURE
    return this.failure
  }

  step(count: number): void {
    const failure = this.tick(count)
    if (failure !== undefined) throw new RangeError(failure)
  }

  table(): void {
    this.charge(TABLE_BYTES)
  }

  closure(upvalues: number): void {
    this.charge(CLOSURE_BYTES + upvalues * UPVALUE_BYTES)
  }

  entry(): void {
    if (this.failure !== undefined) return
    this.entries += 1
    if (this.entries > this.allowance.entries) this.refuse(ENTRIES_FAILURE)
  }

  private charge(size: number): void {
    if (this.failure !== undefined) throw new RangeError(this.failure)
    this.bytes += size
    if (this.bytes > this.allowance.bytes) this.refuse(OBJECTS_FAILURE)
  }

  private allocate(size: number, weight = 1): void {
    if (this.failure !== undefined) {
      if (size <= SMALL_ALLOCATION) return
      throw new RangeError(this.failure)
    }
    if (size > MAX_ALLOCATION) this.refuse("the script built a string over 1 MB")
    this.bytes += size * weight
    if (this.bytes > this.allowance.bytes) this.refuse(BYTES_FAILURE)
  }

  private refuse(failure: string): never {
    this.failure = failure
    throw new RangeError(failure)
  }
}
