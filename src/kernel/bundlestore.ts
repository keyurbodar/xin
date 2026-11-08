import type { JsonValue } from "@earendil-works/chord"
import { arr, bool, compile, lit, obj, opt, str, union, unknown } from "@earendil-works/pi-schema"
import { FragmentId } from "../rowid.ts"
import { BundlePatchArg, normalizePatch, type BundlePatch, type PatchInput } from "./bundlepatch.ts"
import type { Row } from "./layers.ts"

export type BundleSource =
  | { readonly kind: "registry"; readonly version: string; readonly integrity: string }
  | { readonly kind: "local" }

export type BundleRow = {
  readonly id: string
  readonly plugin: string
  readonly config?: JsonValue
  readonly disabled?: boolean
}

export type RowInput = {
  readonly id: string
  readonly plugin: string
  readonly config?: JsonValue | null | undefined
  readonly disabled?: boolean | null | undefined
}

export type RuntimeBundle = {
  readonly package: string
  readonly source: BundleSource
  readonly rows: readonly BundleRow[]
  readonly patch: readonly BundlePatch[]
  readonly requires: readonly string[]
}

export type BundleFailure = { readonly id: string; readonly error: string }

export const BUNDLES_KEY = "plugins.bundles"

const SourceSchema = union([
  obj({ kind: lit("registry"), version: str({ minLength: 1 }), integrity: str({ minLength: 1 }) }),
  obj({ kind: lit("local") }),
])
export const BundleRowArg = obj({
  id: FragmentId,
  plugin: str({ minLength: 1 }),
  config: opt(unknown()),
  disabled: opt(bool()),
})
export const RuntimeBundleSchema = obj({
  package: str({ minLength: 1 }),
  source: SourceSchema,
  rows: arr(BundleRowArg),
  patch: opt(arr(BundlePatchArg)),
  requires: arr(str()),
})
const bundleCheck = compile(RuntimeBundleSchema)

type RuntimeBundleInput = Omit<RuntimeBundle, "patch"> & { readonly patch?: readonly PatchInput[] }

export function normalizeRow(row: RowInput): BundleRow {
  return {
    id: row.id,
    plugin: row.plugin,
    ...(row.config === undefined || row.config === null ? {} : { config: row.config }),
    ...(row.disabled === undefined || row.disabled === null ? {} : { disabled: row.disabled }),
  }
}

export function toRuntimeBundle(value: unknown): RuntimeBundle | undefined {
  if (!bundleCheck.check(value)) return undefined
  const bundle = value as RuntimeBundleInput
  return {
    package: bundle.package,
    source: bundle.source,
    rows: bundle.rows.map((row) => normalizeRow(row)),
    patch: (bundle.patch ?? []).map((entry) => normalizePatch(entry)),
    requires: [...bundle.requires],
  }
}

const isJsonRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameJson(value, right[index]))
  }
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
}

export function bundleRows(bundle: RuntimeBundle): Row[] {
  return bundle.rows.map((row) => ({
    id: row.id,
    name: `cordis:${row.plugin}`,
    ...(row.config === undefined ? {} : { config: row.config }),
    ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
  }))
}

export function readBundles(
  storage: DurableObjectStorage,
  warn: (message: string) => void = () => undefined,
): readonly RuntimeBundle[] {
  const value: unknown = storage.kv.get(BUNDLES_KEY)
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warn("stored runtime bundles are not a list; ignored")
    return []
  }
  return value.flatMap((entry, index) => {
    const bundle = toRuntimeBundle(entry)
    if (bundle !== undefined) return [bundle]
    warn(`stored runtime bundle ${index} is not a bundle; ignored`)
    return []
  })
}

export function writeBundles(storage: DurableObjectStorage, bundles: readonly RuntimeBundle[]): void {
  if (bundles.length === 0) storage.kv.delete(BUNDLES_KEY)
  else storage.kv.put(BUNDLES_KEY, bundles)
}
