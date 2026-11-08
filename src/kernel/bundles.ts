import { isFragment } from "../rowid.ts"
import { OpRejected } from "../ops.ts"
import { serial } from "../serial.ts"
import { patchStates, validatePatches } from "./bundlepatch.ts"
import {
  readBundles,
  sameJson,
  writeBundles,
  type BundleFailure,
  type BundleSource,
  type RuntimeBundle,
} from "./bundlestore.ts"
import type { BundlePatchState } from "./bundlepatch.ts"
import { configSchemaOf, validateConfig } from "./config.ts"
import { pluginOf } from "./layers.ts"
import type { PackageSpec } from "./packages.ts"
import type { RowState, XinLoader } from "./loader.ts"

export * from "./bundlestore.ts"
export { BundlePatchArg, normalizePatch } from "./bundlepatch.ts"
export type { BundlePatch, BundlePatchState, PatchInput } from "./bundlepatch.ts"

export type BundleRowState = { readonly id: string; readonly state: RowState }

export type BundleView = {
  readonly package: string
  readonly source: BundleSource
  readonly requires: readonly string[]
  readonly rows: readonly BundleRowState[]
  readonly patch: readonly BundlePatchState[]
}

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
}

const MAX_ROWS = 64
const MAX_BYTES = 512 * 1024

function fail(message: string): never {
  throw new OpRejected("bad_args", message)
}

export function createBundles(loader: XinLoader, storage: DurableObjectStorage, port: PackagePort): Bundles {
  const queue = serial()

  const validate = (bundle: RuntimeBundle): readonly PackageSpec[] => {
    if (loader.compiled.has(bundle.package)) fail(`bundle ${bundle.package} is compiled into this build`)
    if (!port.validName(bundle.package)) fail(`bundle package ${bundle.package} is not a valid npm name`)
    if (bundle.rows.length > MAX_ROWS) fail(`bundle ${bundle.package} has more than ${MAX_ROWS} rows`)
    if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > MAX_BYTES)
      fail(`bundle ${bundle.package} is larger than 512 KiB`)
    const requires = bundle.requires.map(
      (spec) => port.parse(spec) ?? fail(`bundle ${bundle.package} requires unknown spec ${spec}`),
    )
    const catalog = loader.composition.catalog
    const own = new Set(
      loader.runtime
        .filter((other) => other.package === bundle.package)
        .flatMap((other) => other.rows.map((row) => row.id)),
    )
    const outside = loader.rows().filter((row) => !own.has(row.id))
    const ids = new Set<string>()
    for (const row of bundle.rows) {
      if (!isFragment(row.id)) fail(`bundle ${bundle.package} row id ${row.id} is invalid`)
      if (ids.has(row.id)) fail(`bundle ${bundle.package} row id ${row.id} is repeated`)
      ids.add(row.id)
      if (outside.some((candidate) => candidate.id === row.id))
        fail(`row ${row.id} already exists outside bundle ${bundle.package}`)
      const entry = catalog[row.plugin]
      if (entry === undefined) {
        if (bundle.requires.length === 0)
          fail(`bundle ${bundle.package} names plugin ${row.plugin}, which is not in this build`)
        continue
      }
      if (entry.required === true) fail(`plugin ${row.plugin} is required and cannot come from a bundle`)
      const schema = configSchemaOf(entry.plugin)
      if (schema !== undefined) validateConfig(row.plugin, schema, row.config ?? {})
    }
    const rowPlugin = (id: string): string | undefined => {
      const row = loader.rows().find((candidate) => candidate.id === id)
      return row === undefined ? undefined : pluginOf(row)
    }
    validatePatches(bundle.package, bundle.patch, rowPlugin, catalog)
    return requires
  }

  const failuresOf = async (bundle: RuntimeBundle): Promise<readonly BundleFailure[]> => {
    const failures: BundleFailure[] = []
    for (const row of bundle.rows) {
      const state = await loader.state(row.id)
      if (state.kind === "failed") failures.push({ id: row.id, error: state.error })
    }
    return failures
  }

  return {
    list: async () =>
      Promise.all(
        readBundles(storage).map(async (bundle) => ({
          package: bundle.package,
          source: bundle.source,
          requires: [...bundle.requires],
          rows: await Promise.all(bundle.rows.map(async (row) => ({ id: row.id, state: await loader.state(row.id) }))),
          patch: patchStates(bundle.patch, (id) => !loader.isMissing(id) && loader.rows().some((row) => row.id === id)),
        })),
      ),

    put: (bundle) =>
      queue(async () => {
        const requires = validate(bundle)
        const stored = readBundles(storage)
        const index = stored.findIndex((entry) => entry.package === bundle.package)
        const current = index === -1 ? undefined : stored[index]
        if (current !== undefined && sameJson(current, bundle)) {
          port.cancel(bundle.package)
          const existing = await failuresOf(bundle)
          return existing.length === 0 ? { application: "applied" } : { application: "failed", rows: existing }
        }
        const next = index === -1 ? [...stored, bundle] : stored.map((old, at) => (at === index ? bundle : old))
        writeBundles(storage, next)
        await loader.recompose(next)
        const failures = await failuresOf(bundle)
        if (failures.length === 0) {
          for (const spec of requires) port.record(spec)
          port.cancel(bundle.package)
          return { application: "applied" }
        }
        if (current === undefined) return { application: "failed", rows: failures }
        writeBundles(storage, stored)
        await loader.recompose(stored)
        return { application: "failed", rows: failures }
      }),

    remove: (name) =>
      queue(async () => {
        const stored = readBundles(storage)
        const next = stored.filter((entry) => entry.package !== name)
        if (next.length !== stored.length) {
          writeBundles(storage, next)
          await loader.recompose(next)
        }
        return { application: "applied", package: name }
      }),
  }
}
