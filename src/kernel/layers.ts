import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader"

export type Row = EntryOptions

export type Patch =
  | { readonly insert: readonly Row[] }
  | ({ readonly id: string } & Partial<Pick<Row, "config" | "disabled" | "name">>)

export type Profile = { readonly bundles: readonly string[]; readonly patch: readonly Patch[] }

export type Layer = "bundle" | "profile" | "runtime" | "owner"

const FIELDS = ["name", "config", "disabled"] as const

const PLUGIN_PREFIX = "cordis:"

export const pluginOf = (row: Row): string =>
  row.name.startsWith(PLUGIN_PREFIX) ? row.name.slice(PLUGIN_PREFIX.length) : row.name

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))

export type Applied = { readonly rows: Row[]; readonly unresolved: Patch[] }

export function applyPatches(
  rows: readonly Row[],
  patches: readonly Patch[],
  warn: (message: string) => void,
): Applied {
  const result = rows.map(clone)
  const unresolved: Patch[] = []
  for (const patch of patches) {
    if ("insert" in patch) {
      for (const row of patch.insert) {
        if (result.some((existing) => existing.id === row.id)) warn(`patch inserts ${row.id} twice; kept the first`)
        else result.push(clone(row))
      }
      continue
    }
    const target = result.find((row) => row.id === patch.id)
    if (target === undefined) {
      warn(`patch targets unknown row ${patch.id}; kept until the row comes back`)
      unresolved.push(patch)
      continue
    }
    for (const field of FIELDS) if (field in patch) Object.assign(target, { [field]: clone(patch[field]) })
  }
  return { rows: result, unresolved }
}

export function compose(
  bundles: Readonly<Record<string, readonly Row[]>>,
  profile: Profile,
  runtime: readonly Row[],
  runtimePatches: readonly Patch[],
  warn: (message: string) => void,
): Applied {
  const patches: Patch[] = []
  for (const name of profile.bundles) {
    const rows = bundles[name]
    if (rows === undefined) warn(`profile names unknown bundle ${name}`)
    else patches.push({ insert: rows })
  }
  return applyPatches([], [...patches, ...profile.patch, { insert: runtime }, ...runtimePatches], warn)
}

const normal = (field: (typeof FIELDS)[number], value: unknown): unknown =>
  field === "disabled" ? value === true : (value ?? null)

const same = (field: (typeof FIELDS)[number], a: unknown, b: unknown): boolean =>
  JSON.stringify(normal(field, a)) === JSON.stringify(normal(field, b))

export function departures(lower: readonly Row[], current: readonly Row[]): Patch[] {
  const patches: Patch[] = []
  for (const row of current) {
    const base = lower.find((candidate) => candidate.id === row.id)
    if (base === undefined) {
      patches.push({ insert: [clone(row)] })
      continue
    }
    const changed: Record<string, unknown> = {}
    for (const field of FIELDS) if (!same(field, base[field], row[field])) changed[field] = clone(row[field])
    if (Object.keys(changed).length > 0) patches.push({ id: row.id, ...changed })
  }
  for (const base of lower)
    if (!current.some((row) => row.id === base.id) && base.disabled !== true)
      patches.push({ id: base.id, disabled: true })
  return patches
}

export function layerOf(id: string, profile: Profile, owner: readonly Patch[], runtime: ReadonlySet<string>): Layer {
  const touches = (patch: Patch) => ("insert" in patch ? patch.insert.some((row) => row.id === id) : patch.id === id)
  if (owner.some(touches)) return "owner"
  if (runtime.has(id)) return "runtime"
  if (profile.patch.some(touches)) return "profile"
  return "bundle"
}
