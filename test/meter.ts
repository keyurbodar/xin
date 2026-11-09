/**
 * Durable Object read/write meter for the load benchmark.
 *
 * It wraps the storage a Home uses and counts what Cloudflare bills: SQL rows through the cursor's own
 * `rowsRead`/`rowsWritten` (the values its docs call "the final value used for SQL billing"), key-value methods as one
 * row each, and alarm methods as one row each. Counts are kept in the isolate's `globalThis`, so they survive an
 * eviction and the next instance keeps adding to the same totals.
 */

type Bucket = { calls: number; reads: number; writes: number }

export type Sample = {
  readonly sql: Bucket
  readonly kv: Bucket
  readonly alarm: Bucket
  readonly statements: Record<string, Bucket>
  readonly keys: Record<string, Bucket>
}

type State = {
  label: string
  sql: Bucket
  kv: Bucket
  alarm: Bucket
  statements: Map<string, Bucket>
  keys: Map<string, Bucket>
}

const STATE = Symbol.for("xin.meter.state")
const INSTALLED = Symbol.for("xin.meter.installed")

const empty = (): Bucket => ({ calls: 0, reads: 0, writes: 0 })

function state(): State {
  const holder = globalThis as unknown as Record<symbol, State | undefined>
  const existing = holder[STATE]
  if (existing !== undefined) return existing
  const created: State = {
    label: "boot",
    sql: empty(),
    kv: empty(),
    alarm: empty(),
    statements: new Map(),
    keys: new Map(),
  }
  holder[STATE] = created
  return created
}

function record(bucket: Bucket, reads: number, writes: number): void {
  bucket.calls += 1
  bucket.reads += reads
  bucket.writes += writes
}

function group(map: Map<string, Bucket>, key: string): Bucket {
  const found = map.get(key)
  if (found !== undefined) return found
  const created = empty()
  map.set(key, created)
  return created
}

/** `VERB TABLE` for a statement, so the table's own literals do not split it. */
function shapeOf(sql: string): string {
  const text = sql.replace(/\s+/g, " ").trim()
  const verb = /^[a-z]+/i.exec(text)?.[0]?.toUpperCase() ?? "?"
  const table = /(?:FROM|INTO|UPDATE|TABLE|INDEX|TRIGGER|VIEW)\s+"?([\w.]+)"?/i.exec(text)?.[1]
  return table === undefined ? verb : `${verb} ${table}`
}

/** Document ids to their kind, so a revision write can name the document it belongs to. */
const documentKinds = new Map<number, string>()

const text = (value: unknown): string => (typeof value === "string" ? value.replaceAll('"', "") : "")

/** `shapeOf` plus the kind or status the bound parameters carry, for the statements that fan out by kind. */
function detailOf(sql: string, params: readonly SqlStorageValue[]): string {
  const shape = shapeOf(sql)
  if (shape === "INSERT pi_tasks") return `${shape} ${text(params[2])} ${text(params[3])}`
  if (shape === "INSERT pi_submissions") return `${shape} ${text(params[3])}`
  if (shape === "INSERT pi_documents") {
    const kind = text(params[1])
    if (typeof params[0] === "number") documentKinds.set(params[0], kind)
    return `${shape} ${kind}`
  }
  if (shape === "INSERT pi_document_revisions") {
    const kind = typeof params[0] === "number" ? (documentKinds.get(params[0]) ?? "?") : "?"
    return `${shape} ${kind} ${text(params[2])}`
  }
  if (shape === "INSERT pi_entries") {
    try {
      const entry: unknown = JSON.parse(String(params[4]))
      return `${shape} ${typeof entry === "object" && entry !== null ? text(Reflect.get(entry, "kind")) : "?"}`
    } catch {
      return shape
    }
  }
  return shape
}

/** A cursor that replays rows the meter already read, with the real cursor's billing counters. */
class ReplayCursor<T extends Record<string, SqlStorageValue>> {
  #index = 0

  constructor(
    private readonly rows: T[],
    readonly columnNames: string[],
    readonly rowsRead: number,
    readonly rowsWritten: number,
  ) {}

  next(): IteratorResult<T, undefined> {
    const row = this.rows[this.#index]
    if (row === undefined) return { done: true, value: undefined }
    this.#index += 1
    return { done: false, value: row }
  }

  toArray(): T[] {
    const rest = this.rows.slice(this.#index)
    this.#index = this.rows.length
    return rest
  }

  one(): T {
    const row = this.rows[this.#index]
    if (row === undefined) throw new Error("Expected exactly one row, got none")
    this.#index += 1
    return row
  }

  raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    const values = this.rows.map((row) => Object.values(row) as U)
    return values[Symbol.iterator]()
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this
  }
}

/** A storage method as the meter sees it: any arguments, any result. */
type Callable = (...args: never[]) => unknown

/** Wrap a storage's SQL, key-value and alarm methods, once per storage object. */
export function install(storage: DurableObjectStorage): void {
  const marked = storage as unknown as Record<symbol, boolean | undefined>
  if (marked[INSTALLED] === true) return
  marked[INSTALLED] = true

  const sql = storage.sql
  const exec = sql.exec.bind(sql)
  sql.exec = ((query: string, ...params: SqlStorageValue[]) => {
    const cursor = exec(query, ...params)
    const rows = cursor.toArray()
    const reads = cursor.rowsRead
    const writes = cursor.rowsWritten
    const current = state()
    record(current.sql, reads, writes)
    record(group(current.statements, detailOf(query, params)), reads, writes)
    return new ReplayCursor(rows, cursor.columnNames, reads, writes)
  }) as typeof sql.exec

  const kv = storage.kv as unknown as Record<string, Callable>
  const kvGet = (kv.get as Callable).bind(kv) as (key: string) => unknown
  kv.get = (key: string) => {
    const value = kvGet(key)
    record(state().kv, 1, 0)
    record(group(state().keys, `kv.get ${key}`), 1, 0)
    return value
  }
  const kvPut = (kv.put as Callable).bind(kv) as (key: string, value: unknown) => unknown
  kv.put = (key: string, value: unknown) => {
    const result = kvPut(key, value)
    record(state().kv, 0, 1)
    record(group(state().keys, `kv.put ${key}`), 0, 1)
    return result
  }
  const kvDelete = (kv.delete as Callable).bind(kv) as (key: string) => unknown
  kv.delete = (key: string) => {
    const result = kvDelete(key)
    record(state().kv, 0, 1)
    record(group(state().keys, `kv.delete ${key}`), 0, 1)
    return result
  }
  const kvList = (kv.list as Callable).bind(kv) as (...args: never[]) => Map<string, unknown>
  kv.list = (...args: never[]) => {
    const result = kvList(...args)
    const reads = Math.max(typeof result?.size === "number" ? result.size : 0, 1)
    record(state().kv, reads, 0)
    record(group(state().keys, "kv.list"), reads, 0)
    return result
  }

  const getAlarm = (storage.getAlarm as Callable).bind(storage) as () => Promise<number | null>
  storage.getAlarm = () => {
    record(state().alarm, 1, 0)
    record(group(state().keys, "alarm.get"), 1, 0)
    return getAlarm()
  }
  const setAlarm = (storage.setAlarm as Callable).bind(storage) as (at: number | Date) => Promise<void>
  storage.setAlarm = (at: number | Date) => {
    record(state().alarm, 0, 1)
    record(group(state().keys, "alarm.set"), 0, 1)
    return setAlarm(at)
  }
  const deleteAlarm = (storage.deleteAlarm as Callable).bind(storage) as () => Promise<void>
  storage.deleteAlarm = () => {
    record(state().alarm, 0, 1)
    record(group(state().keys, "alarm.delete"), 0, 1)
    return deleteAlarm()
  }
}

export function setLabel(label: string): void {
  state().label = label
}

/** The cumulative totals, with the per-statement and per-key detail sorted by cost. */
export function sample(): Sample {
  const current = state()
  return {
    sql: { ...current.sql },
    kv: { ...current.kv },
    alarm: { ...current.alarm },
    statements: sorted(current.statements),
    keys: sorted(current.keys),
  }
}

function sorted(map: Map<string, Bucket>): Record<string, Bucket> {
  return Object.fromEntries(
    [...map.entries()]
      .map(([key, bucket]) => [key, { ...bucket }] as const)
      .toSorted((left, right) => right[1].writes - left[1].writes || right[1].reads - left[1].reads),
  )
}
