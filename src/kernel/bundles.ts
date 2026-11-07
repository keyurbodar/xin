import type { JsonValue } from "@earendil-works/chord"
import { arr, bool, compile, lit, obj, opt, str, union, unknown } from "@earendil-works/pi-schema"
import { OpRejected } from "../ops.ts"
import { FragmentId, isFragment, runtimeRowId } from "../rowid.ts"
import { configSchemaOf, validateConfig } from "./config.ts"
import { pluginOf, type Row } from "./layers.ts"
import type { RowState, XinLoader } from "./loader.ts"
import type { PackageSpec } from "./packages.ts"

export type BundleSource =
  | { readonly kind: "registry"; readonly version: string; readonly integrity: string }
  | { readonly kind: "local" }

export type BundleRow = {
  readonly id: string
  readonly plugin: string
  readonly config?: JsonValue
  readonly disabled?: boolean
}

export type RuntimeBundle = {
  readonly package: string
  readonly source: BundleSource
  readonly rows: readonly BundleRow[]
  readonly requires: readonly string[]
}

export type StoredBundle = {
  readonly bundle: RuntimeBundle
  readonly previous?: RuntimeBundle
}

export type BundleRowState = { readonly id: string; readonly state: RowState }

export type BundleView = {
  readonly package: string
  readonly source: BundleSource
  readonly requires: readonly string[]
  readonly previous: string | null
  readonly rows: readonly BundleRowState[]
}

export type BundleFailure = { readonly id: string; readonly error: string }

export type BundleApplication =
  | { readonly application: "applied" }
  | { readonly application: "failed"; readonly rows: readonly BundleFailure[] }

export type PackagePort = {
  readonly validName: (name: string) => boolean
  readonly parse: (spec: string) => PackageSpec | undefined
  readonly record: (spec: PackageSpec) => void
  readonly cancel: (name: string) => void
}

export type Bundles = {
  list(): Promise<readonly BundleView[]>
  put(bundle: RuntimeBundle): Promise<BundleApplication>
  remove(name: string): Promise<{ readonly application: "applied"; readonly package: string }>
  rollback(name: string): Promise<BundleApplication>
}

const BUNDLES_KEY = "plugins.bundles"
const MAX_ROWS = 64
const MAX_BYTES = 512 * 1024

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
const BundleSchema = obj({
  package: str({ minLength: 1 }),
  source: SourceSchema,
  rows: arr(BundleRowArg),
  requires: arr(str()),
})
const StoredSchema = obj({ bundle: BundleSchema, previous: opt(BundleSchema) })
const storedCheck = compile(StoredSchema)

type JsonRecord = { readonly [key: string]: unknown }

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sameJson = (left: unknown, right: unknown): boolean => {
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

export function readBundles(storage: DurableObjectStorage, warn: (message: string) => void): readonly StoredBundle[] {
  const value: unknown = storage.kv.get(BUNDLES_KEY)
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warn("stored runtime bundles are not a list; ignored")
    return []
  }
  return value.flatMap((entry, index) => {
    if (storedCheck.check(entry)) return [entry as StoredBundle]
    warn(`stored runtime bundle ${index} is not a bundle; ignored`)
    return []
  })
}

export function writeBundles(storage: DurableObjectStorage, bundles: readonly StoredBundle[]): void {
  if (bundles.length === 0) storage.kv.delete(BUNDLES_KEY)
  else storage.kv.put(BUNDLES_KEY, bundles)
}

const read = (storage: DurableObjectStorage): readonly StoredBundle[] => readBundles(storage, () => undefined)

const runtimeOf = (stored: readonly StoredBundle[]): RuntimeBundle[] => stored.map((entry) => entry.bundle)

const previousVersion = (previous: RuntimeBundle | undefined): string | null =>
  previous === undefined ? null : previous.source.kind === "registry" ? previous.source.version : "local"

function fail(message: string): never {
  throw new OpRejected("bad_args", message)
}

export function createBundles(loader: XinLoader, storage: DurableObjectStorage, port: PackagePort): Bundles {
  let tail: Promise<void> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const validate = (bundle: RuntimeBundle): readonly PackageSpec[] => {
    if (!port.validName(bundle.package)) fail(`bundle package ${bundle.package} is not a valid npm name`)
    if (bundle.rows.length > MAX_ROWS) fail(`bundle ${bundle.package} has more than ${MAX_ROWS} rows`)
    if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > MAX_BYTES)
      fail(`bundle ${bundle.package} is larger than 512 KiB`)
    const requires = bundle.requires.map((spec) => {
      const parsed = port.parse(spec)
      return parsed ?? fail(`bundle ${bundle.package} requires unknown spec ${spec}`)
    })
    const catalog = loader.composition.catalog
    const own = new Set(
      loader.runtime
        .filter((other) => other.package === bundle.package)
        .flatMap((other) => other.rows.map((row) => runtimeRowId(other.package, row.id))),
    )
    const outside = loader.rows().filter((row) => !own.has(row.id))
    const ids = new Set<string>()
    for (const row of bundle.rows) {
      if (!isFragment(row.id)) fail(`bundle ${bundle.package} row id ${row.id} is invalid`)
      if (ids.has(row.id)) fail(`bundle ${bundle.package} row id ${row.id} is repeated`)
      ids.add(row.id)
      const id = runtimeRowId(bundle.package, row.id)
      if (outside.some((candidate) => candidate.id === id))
        fail(`row ${id} already exists outside bundle ${bundle.package}`)
      const entry = catalog[row.plugin]
      if (entry === undefined) {
        if (bundle.requires.length === 0)
          fail(`bundle ${bundle.package} names plugin ${row.plugin}, which is not in this build`)
        continue
      }
      if (entry.required === true) fail(`plugin ${row.plugin} is required and cannot come from a bundle`)
      if (entry.multiple !== true) {
        if (outside.some((candidate) => pluginOf(candidate) === row.plugin))
          fail(`a ${row.plugin} row already exists in this tree`)
        if (bundle.rows.filter((candidate) => candidate.plugin === row.plugin).length > 1)
          fail(`bundle ${bundle.package} adds more than one ${row.plugin} row`)
      }
      const schema = configSchemaOf(entry.plugin)
      if (schema !== undefined) validateConfig(row.plugin, schema, row.config ?? {})
    }
    return requires
  }

  const failuresOf = async (bundle: RuntimeBundle): Promise<BundleFailure[]> => {
    const failures: BundleFailure[] = []
    for (const row of bundle.rows) {
      const id = runtimeRowId(bundle.package, row.id)
      const state = await loader.state(id)
      if (state.kind === "failed") failures.push({ id, error: state.error })
    }
    return failures
  }

  const recompose = (stored: readonly StoredBundle[]): Promise<void> => loader.recompose(runtimeOf(stored))

  return {
    list: async () =>
      Promise.all(
        read(storage).map(async (entry) => ({
          package: entry.bundle.package,
          source: entry.bundle.source,
          requires: [...entry.bundle.requires],
          previous: previousVersion(entry.previous),
          rows: await Promise.all(
            entry.bundle.rows.map(async (row) => {
              const id = runtimeRowId(entry.bundle.package, row.id)
              const state: RowState = loader.isSuperseded(entry.bundle.package)
                ? { kind: "superseded" }
                : await loader.state(id)
              return { id, state }
            }),
          ),
        })),
      ),

    put: (bundle) =>
      serial(async () => {
        const requires = validate(bundle)
        const stored = read(storage)
        const index = stored.findIndex((entry) => entry.bundle.package === bundle.package)
        const current = index === -1 ? undefined : stored[index]?.bundle
        if (current !== undefined && sameJson(current, bundle)) {
          port.cancel(bundle.package)
          return { application: "applied" }
        }
        const entry: StoredBundle = { bundle, ...(current === undefined ? {} : { previous: current }) }
        const next = index === -1 ? [...stored, entry] : stored.map((old, at) => (at === index ? entry : old))
        writeBundles(storage, next)
        await recompose(next)
        const failures = await failuresOf(bundle)
        if (failures.length > 0) {
          writeBundles(storage, stored)
          await recompose(stored)
          return { application: "failed", rows: failures }
        }
        for (const spec of requires) port.record(spec)
        port.cancel(bundle.package)
        return { application: "applied" }
      }),

    remove: (name) =>
      serial(async () => {
        const stored = read(storage)
        const next = stored.filter((entry) => entry.bundle.package !== name)
        if (next.length !== stored.length) {
          writeBundles(storage, next)
          await recompose(next)
        }
        return { application: "applied", package: name }
      }),

    rollback: (name) =>
      serial(async () => {
        const stored = read(storage)
        const index = stored.findIndex((entry) => entry.bundle.package === name)
        const entry = stored[index]
        if (entry === undefined) fail(`${name} is not a runtime bundle`)
        if (entry.previous === undefined) fail(`${name} has no previous version`)
        const swapped: StoredBundle = { bundle: entry.previous, previous: entry.bundle }
        const next = stored.map((old, at) => (at === index ? swapped : old))
        writeBundles(storage, next)
        await recompose(next)
        const failures = await failuresOf(swapped.bundle)
        return failures.length === 0 ? { application: "applied" } : { application: "failed", rows: failures }
      }),
  }
}
