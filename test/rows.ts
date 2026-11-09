import { runInDurableObject } from "cloudflare:test"
import type { Stub } from "./support.ts"

/**
 * Counts the rows Cloudflare bills for a Durable Object, the way Kiko's dev meter does
 * (`apps/server/src/lib/dev-stats-patch.ts`): every `sql.exec` cursor's own `rowsRead` /
 * `rowsWritten`, plus the KV and alarm methods, which are billed as rows too.
 *
 * Start it before the scenario and read it after. The meter lives on the object's storage, so a
 * scenario that evicts or restarts the object loses it; `snapshot` then says so instead of
 * reporting zero. SQL counts are final once the caller has iterated a cursor, so snapshot after
 * the work has drained.
 */
export type Billed = {
  /** Rows read: SQL scans, KV gets and the keys a KV list returns. */
  readonly read: number
  /** Rows written: SQL writes (index rows included), KV puts and deletes, and the alarm slot. */
  readonly written: number
  readonly sql: { readonly read: number; readonly written: number }
  readonly kv: { readonly read: number; readonly written: number }
  readonly alarm: { readonly writes: number }
}

type Cursor = { readonly rowsRead: number; readonly rowsWritten: number }

type Counter = {
  sql: { read: number; written: number }
  kv: { read: number; written: number }
  alarm: number
  open: Cursor[]
}

const METER = Symbol.for("xin.rows.meter")

type Metered = { [METER]?: Counter }

const counterOf = (storage: object): Counter | undefined => (storage as Metered)[METER]

const settle = (counter: Counter): void => {
  for (const cursor of counter.open.splice(0)) {
    counter.sql.read += cursor.rowsRead
    counter.sql.written += cursor.rowsWritten
  }
}

const billed = (counter: Counter): Billed => {
  settle(counter)
  return {
    read: counter.sql.read + counter.kv.read,
    written: counter.sql.written + counter.kv.written + counter.alarm,
    sql: { ...counter.sql },
    kv: { ...counter.kv },
    alarm: { writes: counter.alarm },
  }
}

const patch = (storage: DurableObjectStorage): Counter => {
  const existing = counterOf(storage)
  if (existing !== undefined) return existing
  const counter: Counter = { sql: { read: 0, written: 0 }, kv: { read: 0, written: 0 }, alarm: 0, open: [] }
  ;(storage as Metered)[METER] = counter

  const sql = storage.sql as unknown as { exec: (...args: never[]) => Cursor }
  const exec = sql.exec
  Object.defineProperty(sql, "exec", {
    configurable: true,
    value: (...args: never[]) => {
      const cursor = Reflect.apply(exec, sql, args) as Cursor
      counter.open.push(cursor)
      if (counter.open.length > 4_000) settle(counter)
      return cursor
    },
  })

  const kv = (storage as unknown as { kv?: Record<string, unknown> }).kv
  for (const target of kv === undefined ? [storage as unknown as Record<string, unknown>] : [kv]) {
    for (const name of ["get", "put", "delete", "list"]) {
      const method = target[name]
      if (typeof method !== "function") continue
      Object.defineProperty(target, name, {
        configurable: true,
        value: (...args: unknown[]) => {
          const value = Reflect.apply(method as (...a: unknown[]) => unknown, target, args)
          if (name === "get") counter.kv.read += 1
          if (name === "put")
            counter.kv.written += typeof args[0] === "string" ? 1 : Object.keys(args[0] as object).length
          if (name !== "delete" && name !== "list") return value
          return Promise.resolve(value).then((result) => {
            if (name === "list") counter.kv.read += result instanceof Map ? result.size : 0
            else counter.kv.written += typeof result === "number" ? result : result === true ? 1 : 0
            return result
          })
        },
      })
    }
  }

  const alarm = storage as unknown as Record<string, unknown>
  for (const name of ["setAlarm", "deleteAlarm"]) {
    const method = alarm[name]
    if (typeof method !== "function") continue
    Object.defineProperty(alarm, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        counter.alarm += 1
        return Reflect.apply(method as (...a: unknown[]) => unknown, alarm, args)
      },
    })
  }

  return counter
}

export type Meter = {
  /** Forget everything counted so far, so setup work does not land in the scenario. */
  reset(): Promise<void>
  snapshot(): Promise<Billed>
}

const current = (storage: object): Counter => {
  const counter = counterOf(storage)
  if (counter === undefined) throw new Error("the rows meter was lost: the object restarted mid-scenario")
  return counter
}

export const startMeter = async (stub: Stub): Promise<Meter> => {
  await runInDurableObject(stub, (_home: unknown, state) => {
    patch(state.storage)
    return Promise.resolve()
  })
  return {
    reset: () =>
      runInDurableObject(stub, (_home: unknown, state) => {
        const counter = current(state.storage)
        settle(counter)
        counter.sql.read = 0
        counter.sql.written = 0
        counter.kv.read = 0
        counter.kv.written = 0
        counter.alarm = 0
        return Promise.resolve()
      }),
    snapshot: () =>
      runInDurableObject(stub, (_home: unknown, state) => Promise.resolve(billed(current(state.storage)))),
  }
}
