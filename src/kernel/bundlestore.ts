import type { JsonValue } from "@earendil-works/chord"
import { arr, bool, compile, lit, obj, opt, str, union, unknown } from "@earendil-works/pi-schema"
import { FragmentId, runtimeRowId } from "../rowid.ts"
import { BundlePatchArg, normalizePatch, type BundlePatch, type PatchInput } from "./bundlepatch.ts"
import type { Patch, Row } from "./layers.ts"
import { parseOwnerPatch, readOwnerPatch, writeOwnerPatch } from "./patch.ts"

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

export type StoredBundle = {
  readonly bundle: RuntimeBundle
  readonly previous?: RuntimeBundle
}

export type BundleFailure = { readonly id: string; readonly error: string }

export type ActiveSetup = {
  readonly bundles: readonly RuntimeBundle[]
  readonly patch: readonly Patch[]
}

export const BUNDLES_KEY = "plugins.bundles"
export const PROFILES_KEY = "plugins.profiles"

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
const StoredSchema = obj({ bundle: RuntimeBundleSchema, previous: opt(RuntimeBundleSchema) })
const bundleCheck = compile(RuntimeBundleSchema)
const storedCheck = compile(StoredSchema)

type RuntimeBundleInput = Omit<RuntimeBundle, "patch"> & { readonly patch?: readonly PatchInput[] }

type StoredInput = { readonly bundle: RuntimeBundleInput; readonly previous?: RuntimeBundleInput }

type JsonRecord = { readonly [key: string]: unknown }

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

const isJsonRecord = (value: unknown): value is JsonRecord =>
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
    id: runtimeRowId(bundle.package, row.id),
    name: `cordis:${row.plugin}`,
    ...(row.config === undefined ? {} : { config: row.config }),
    ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
  }))
}

export function runtimeRows(bundles: readonly RuntimeBundle[]): Row[] {
  return bundles.flatMap(bundleRows)
}

function storedBundle(value: unknown): StoredBundle | undefined {
  if (!storedCheck.check(value)) return undefined
  const entry = value as StoredInput
  const bundle = toRuntimeBundle(entry.bundle)
  if (bundle === undefined) return undefined
  if (entry.previous === undefined) return { bundle }
  const previous = toRuntimeBundle(entry.previous)
  return previous === undefined ? undefined : { bundle, previous }
}

export function readBundles(storage: DurableObjectStorage, warn: (message: string) => void): readonly StoredBundle[] {
  const value: unknown = storage.kv.get(BUNDLES_KEY)
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warn("stored runtime bundles are not a list; ignored")
    return []
  }
  return value.flatMap((entry, index) => {
    const parsed = storedBundle(entry)
    if (parsed !== undefined) return [parsed]
    warn(`stored runtime bundle ${index} is not a bundle; ignored`)
    return []
  })
}

export function writeBundles(storage: DurableObjectStorage, bundles: readonly StoredBundle[]): void {
  if (bundles.length === 0) storage.kv.delete(BUNDLES_KEY)
  else storage.kv.put(BUNDLES_KEY, bundles)
}

const setupOf = (record: JsonRecord): ActiveSetup | undefined => {
  if (!Array.isArray(record.bundles) || !Array.isArray(record.patch)) return undefined
  const bundles: RuntimeBundle[] = []
  for (const entry of record.bundles) {
    const bundle = toRuntimeBundle(entry)
    if (bundle === undefined) return undefined
    bundles.push(bundle)
  }
  return { bundles, patch: parseOwnerPatch(record.patch, () => undefined) }
}

export function readActiveSetup(
  storage: DurableObjectStorage,
  warn: (message: string) => void,
): ActiveSetup | undefined {
  const value: unknown = storage.kv.get(PROFILES_KEY)
  if (!isJsonRecord(value)) return undefined
  const setup = setupOf(value)
  if (setup === undefined) warn("stored profiles have no usable active setup; ignored")
  return setup
}

export function writeActiveSetup(
  storage: DurableObjectStorage,
  bundles: readonly RuntimeBundle[],
  patch: readonly Patch[],
): void {
  const value: unknown = storage.kv.get(PROFILES_KEY)
  if (!isJsonRecord(value) || typeof value.active !== "string") return
  storage.kv.put(PROFILES_KEY, { ...value, bundles, patch })
}

export function reconcileActiveSetup(storage: DurableObjectStorage, warn: (message: string) => void): void {
  const setup = readActiveSetup(storage, warn)
  if (setup === undefined) return
  const stored = readBundles(storage, warn).map((entry) => entry.bundle)
  const owner = readOwnerPatch(storage, warn)
  const matches =
    stored.length === setup.bundles.length && stored.every((bundle, index) => sameJson(bundle, setup.bundles[index]))
  if (!matches)
    writeBundles(
      storage,
      setup.bundles.map((bundle) => ({ bundle })),
    )
  if (!sameJson(owner, setup.patch)) writeOwnerPatch(storage, setup.patch)
}
