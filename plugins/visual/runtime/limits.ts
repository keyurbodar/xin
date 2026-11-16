export const MAX_ALLOCATION = (1 << 20) + 64
export const BYTES_PER_CALL = 32 << 20
export const TABLE_ENTRIES_PER_CALL = 100_000
const SMALL = 4096

const BYTES_FAILURE =
  "the script built too much text in one call (repeated `..` in a loop copies the whole string each time; collect parts in a table and use table.concat)"
const ENTRIES_FAILURE = "the script filled tables with too many entries in one call; summarize the data first"

/** One visual's per-call allowance. `failure` is sticky: once set, the instruction hook raises it again until the call returns, so `pcall` cannot swallow it. */
export class Meter {
  failure: string | undefined = undefined
  private bytes = 0
  private entries = 0

  reset(): void {
    this.failure = undefined
    this.bytes = 0
    this.entries = 0
  }

  allocate(size: number): void {
    if (this.failure !== undefined) {
      if (size <= SMALL) return
      throw new RangeError(this.failure)
    }
    if (size > MAX_ALLOCATION) this.refuse("the script built a string over 1 MB")
    this.bytes += size
    if (this.bytes > BYTES_PER_CALL) this.refuse(BYTES_FAILURE)
  }

  grow(): void {
    this.entries += 1
    if (this.entries > TABLE_ENTRIES_PER_CALL && this.failure === undefined) this.failure = ENTRIES_FAILURE
  }

  private refuse(failure: string): never {
    this.failure = failure
    throw new RangeError(failure)
  }
}

let current: Meter | undefined
let depth = 0

const NativeBytes = Uint8Array
const NativeMap = Map

const MeteredBytes = new Proxy(NativeBytes, {
  construct(target, args: unknown[], newTarget) {
    const [first] = args
    if (typeof first === "number") current?.allocate(first)
    return Reflect.construct(target, args, newTarget)
  },
})

class MeteredMap<K, V> extends NativeMap<K, V> {
  override set(key: K, value: V): this {
    const size = this.size
    super.set(key, value)
    if (this.size > size) current?.grow()
    return this
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof NativeMap
  }
}

/**
 * Run Lua under a meter. fengari has no allocator hook and its module objects are not shared across bundlers, so for the length of the call the
 * globals it allocates through (`new Uint8Array` for every string and buffer, `new Map` for every table) are counting subclasses.
 */
export function metered<T>(meter: Meter, run: () => T): T {
  const outer = current
  current = meter
  depth += 1
  if (depth === 1) {
    globalThis.Uint8Array = MeteredBytes
    globalThis.Map = MeteredMap
  }
  try {
    return run()
  } finally {
    depth -= 1
    current = outer
    if (depth === 0) {
      globalThis.Uint8Array = NativeBytes
      globalThis.Map = NativeMap
    }
  }
}
