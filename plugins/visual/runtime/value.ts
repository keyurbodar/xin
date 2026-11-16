// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

export type LuaFunction = { readonly kind: "function"; readonly ref: number }

export type LuaTable = {
  readonly kind: "table"
  readonly seq: readonly LuaValue[]
  readonly keys: ReadonlyMap<string, LuaValue>
}

export type LuaValue = undefined | boolean | number | string | LuaFunction | LuaTable

export const isTable = (value: LuaValue): value is LuaTable => typeof value === "object" && value.kind === "table"

export const isFunction = (value: LuaValue): value is LuaFunction =>
  typeof value === "object" && value.kind === "function"

export function typeName(value: LuaValue): string {
  if (value === undefined) return "nil"
  if (typeof value === "object") return value.kind
  return typeof value
}

export function numberText(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  return value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "")
}

export function valueText(value: LuaValue): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return numberText(value)
  if (typeof value === "boolean") return String(value)
  return value.kind
}

export type Plain =
  | null
  | boolean
  | number
  | string
  | ((...args: number[]) => number)
  | Plain[]
  | { [key: string]: Plain }

/** A Lua table as plain JS: a pure sequence becomes an array, anything keyed becomes an object (sequence items under "1", "2", ...). */
export function plain(value: LuaValue, call: (fn: LuaFunction) => (...args: number[]) => number): Plain {
  if (value === undefined) return null
  if (typeof value !== "object") return value
  if (value.kind === "function") return call(value)
  if (value.keys.size === 0) return value.seq.map((item) => plain(item, call))
  const out: { [key: string]: Plain } = {}
  value.seq.forEach((item, index) => {
    out[String(index + 1)] = plain(item, call)
  })
  for (const [key, item] of value.keys) out[key] = plain(item, call)
  return out
}
