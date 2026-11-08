import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader"

export type Row = EntryOptions

export type Patch =
  | { readonly insert: readonly Row[] }
  | ({ readonly id: string } & Partial<Pick<Row, "config" | "disabled" | "name">>)

export type Profile = { readonly bundles: readonly string[]; readonly patch: readonly Patch[] }

export type Layer = "bundle" | "runtime" | "profile" | "owner"

export type RowTrace = { readonly addedBy: Layer; readonly patchedBy: readonly Layer[] }

export type Applied = {
  readonly rows: Row[]
  readonly unresolved: Patch[]
  readonly trace: ReadonlyMap<string, RowTrace>
}

export type RuntimeLayer = { readonly rows: readonly Row[]; readonly patch: readonly Patch[] }

const FIELDS = ["name", "config", "disabled"] as const

const PLUGIN_PREFIX = "cordis:"

export const pluginOf = (row: Row): string =>
  row.name.startsWith(PLUGIN_PREFIX) ? row.name.slice(PLUGIN_PREFIX.length) : row.name

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))

const empty = (): Applied => ({ rows: [], unresolved: [], trace: new Map<string, RowTrace>() })

const patchedBy = (layers: readonly Layer[], layer: Layer): readonly Layer[] =>
  layers.includes(layer) ? layers : [...layers, layer]

export function applyPatches(
  rows: readonly Row[],
  patches: readonly Patch[],
  warn: (message: string) => void,
  layer: Layer,
  trace: ReadonlyMap<string, RowTrace> = new Map(),
): Applied {
  const result = rows.map(clone)
  const rowsTrace = new Map(trace)
  const unresolved: Patch[] = []
  for (const patch of patches) {
    if ("insert" in patch) {
      for (const row of patch.insert) {
        if (result.some((existing) => existing.id === row.id)) {
          warn(`patch inserts ${row.id} twice; kept the first`)
          continue
        }
        result.push(clone(row))
        rowsTrace.set(row.id, { addedBy: layer, patchedBy: [] })
      }
      continue
    }
    const target = result.find((row) => row.id === patch.id)
    if (target === undefined) {
      warn(`patch targets unknown row ${patch.id}; kept until the row comes back`)
      unresolved.push(patch)
      continue
    }
    const current = rowsTrace.get(patch.id)
    rowsTrace.set(patch.id, {
      addedBy: current?.addedBy ?? layer,
      patchedBy: patchedBy(current?.patchedBy ?? [], layer),
    })
    for (const field of FIELDS) if (field in patch) Object.assign(target, { [field]: clone(patch[field]) })
  }
  return { rows: result, unresolved, trace: rowsTrace }
}

export function compose(
  bundles: Readonly<Record<string, readonly Row[]>>,
  profile: Profile,
  runtime: readonly RuntimeLayer[],
  warn: (message: string) => void,
): Applied {
  let applied = empty()
  const step = (patches: readonly Patch[], layer: Layer): void => {
    const next = applyPatches(applied.rows, patches, warn, layer, applied.trace)
    applied = {
      rows: next.rows,
      unresolved: [...applied.unresolved, ...next.unresolved],
      trace: next.trace,
    }
  }
  for (const name of profile.bundles) {
    const rows = bundles[name]
    if (rows === undefined) warn(`profile names unknown bundle ${name}`)
    else step([{ insert: rows }], "bundle")
  }
  for (const bundle of runtime) step([{ insert: bundle.rows }], "runtime")
  for (const bundle of runtime) step(bundle.patch, "runtime")
  step(profile.patch, "profile")
  return applied
}

const normal = (field: (typeof FIELDS)[number], value: unknown): unknown =>
  field === "disabled" ? value === true : (value ?? null)

const same = (field: (typeof FIELDS)[number], a: unknown, b: unknown): boolean =>
  JSON.stringify(normal(field, a)) === JSON.stringify(normal(field, b))

export function departures(
  lower: readonly Row[],
  current: readonly Row[],
  resolveConfig: (row: Row) => unknown = (row) => row.config ?? null,
): Patch[] {
  const patches: Patch[] = []
  const changedField = (base: Row, row: Row, field: (typeof FIELDS)[number]): boolean =>
    field === "config"
      ? JSON.stringify(resolveConfig(base)) !== JSON.stringify(resolveConfig(row))
      : !same(field, base[field], row[field])
  for (const row of current) {
    const base = lower.find((candidate) => candidate.id === row.id)
    if (base === undefined) {
      patches.push({ insert: [clone(row)] })
      continue
    }
    const changed: Record<string, unknown> = {}
    for (const field of FIELDS) if (changedField(base, row, field)) changed[field] = clone(row[field])
    if (Object.keys(changed).length > 0) patches.push({ id: row.id, ...changed })
  }
  for (const base of lower)
    if (!current.some((row) => row.id === base.id) && base.disabled !== true)
      patches.push({ id: base.id, disabled: true })
  return patches
}
