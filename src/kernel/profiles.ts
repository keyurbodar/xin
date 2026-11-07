import type { Context } from "@deepseek-ai/cordis"
import type { JsonValue } from "@earendil-works/chord"
import { arr, compile, map, obj, opt, str } from "@earendil-works/pi-schema"
import { isPackageName, MAX_PACKAGE_NAME } from "../npmname.ts"
import { defineOp, OpRejected } from "../ops.ts"
import { FragmentId, isFragment, isRuntimeRowId, MAX_FRAGMENT, runtimeRowId } from "../rowid.ts"
import {
  normalizePatch,
  normalizeRow,
  PROFILES_KEY,
  readBundles,
  RuntimeBundleSchema,
  toRuntimeBundle,
  type BundlePatch,
  type BundleRow,
  type RowInput,
  type RuntimeBundle,
} from "./bundles.ts"
import { pluginOf, type Patch, type Row } from "./layers.ts"
import { PatchArg, readOwnerPatch } from "./patch.ts"
import { toJson } from "./packages.ts"

export type StoredProfile = {
  readonly bundles: readonly RuntimeBundle[]
  readonly patch: readonly Patch[]
}

export type ProfilesState = {
  readonly active: string
  readonly bundles: readonly RuntimeBundle[]
  readonly patch: readonly Patch[]
  readonly profiles: Readonly<Record<string, StoredProfile>>
}

export type ExportPatch = BundlePatch
export type ExportRow = BundleRow

const DEFAULT_PROFILE = "default"
const OWNER = ["owner"] as const
const MAX_VERSION = 128

const ProfileSchema = obj({ bundles: arr(RuntimeBundleSchema), patch: arr(PatchArg) })
const StateSchema = obj({
  active: str({ minLength: 1 }),
  bundles: arr(RuntimeBundleSchema),
  patch: arr(PatchArg),
  profiles: map(ProfileSchema),
})
const stateCheck = compile(StateSchema)

const PluginArg = str({ minLength: 1, maxLength: MAX_PACKAGE_NAME })
const VersionArg = str({ minLength: 1, maxLength: MAX_VERSION })

type ProfileInput = { readonly bundles: readonly unknown[]; readonly patch: readonly Patch[] }

type StateInput = {
  readonly active: string
  readonly bundles: readonly unknown[]
  readonly patch: readonly Patch[]
  readonly profiles: Readonly<Record<string, ProfileInput>>
}

type StateRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "ok"; readonly state: ProfilesState }

const profileOf = (input: {
  readonly bundles: readonly unknown[]
  readonly patch: readonly Patch[]
}): StoredProfile | undefined => {
  const bundles: RuntimeBundle[] = []
  for (const entry of input.bundles) {
    const bundle = toRuntimeBundle(entry)
    if (bundle === undefined) return undefined
    bundles.push(bundle)
  }
  return { bundles, patch: input.patch }
}

const readState = (storage: DurableObjectStorage): StateRead => {
  const value: unknown = storage.kv.get(PROFILES_KEY)
  if (value === undefined) return { kind: "absent" }
  if (!stateCheck.check(value))
    return { kind: "invalid", message: "stored profiles are not a profile set; kept as stored" }
  const input = value as StateInput
  const profiles: Record<string, StoredProfile> = {}
  for (const [name, entry] of Object.entries(input.profiles)) {
    const profile = profileOf(entry)
    if (profile === undefined)
      return { kind: "invalid", message: `stored profile ${name} is not a profile; kept as stored` }
    profiles[name] = profile
  }
  const active = profileOf({ bundles: input.bundles, patch: input.patch })
  if (active === undefined)
    return { kind: "invalid", message: "the stored active setup is not a setup; kept as stored" }
  if (profiles[input.active] === undefined)
    return {
      kind: "invalid",
      message: `stored profiles name unknown active profile ${input.active}; kept as stored`,
    }
  return { kind: "ok", state: { active: input.active, bundles: active.bundles, patch: active.patch, profiles } }
}

const writeState = (storage: DurableObjectStorage, state: ProfilesState): void => {
  storage.kv.put(PROFILES_KEY, state)
}

const isInsert = (patch: Patch): patch is { readonly insert: readonly Row[] } => "insert" in patch

const exportRow = (row: RowInput): BundleRow => normalizeRow(row)

const appliedTo = (row: BundleRow, patch: Patch): BundleRow => {
  if (isInsert(patch)) return row
  return normalizeRow({
    id: row.id,
    plugin: row.plugin,
    config: patch.config === undefined ? row.config : patch.config,
    disabled: patch.disabled === undefined ? row.disabled : patch.disabled,
  })
}

const exportPatch = (entry: {
  readonly id: string
  readonly config?: unknown
  readonly disabled?: boolean | null | undefined
}): ExportPatch[] => {
  const patch = normalizePatch({
    id: entry.id,
    config: entry.config as JsonValue | undefined,
    disabled: entry.disabled,
  })
  return patch.config === undefined && patch.disabled === undefined ? [] : [patch]
}

const uniqueId = (base: string, used: Set<string>): string => {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let index = 2; ; index++) {
    const suffix = `-${index}`
    const candidate = `${base.slice(0, MAX_FRAGMENT - suffix.length)}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

function manifestOf(
  profile: StoredProfile,
  multiple: (plugin: string) => boolean,
  packageName: string,
  version: string,
): JsonValue {
  const overrides = new Map<string, Patch>()
  for (const patch of profile.patch) if (!isInsert(patch)) overrides.set(patch.id, patch)

  const candidates: BundleRow[] = []
  for (const bundle of profile.bundles)
    for (const row of bundle.rows) {
      const override = overrides.get(runtimeRowId(bundle.package, row.id))
      candidates.push(exportRow(override === undefined ? row : appliedTo(row, override)))
    }
  for (const patch of profile.patch)
    if (isInsert(patch))
      for (const row of patch.insert) {
        const plugin = pluginOf(row)
        if (!isFragment(row.id) || !multiple(plugin)) continue
        candidates.push(exportRow({ id: row.id, plugin, config: row.config, disabled: row.disabled }))
      }

  const used = new Set<string>()
  const bundleRows = candidates.map((row) => ({ ...row, id: uniqueId(row.id, used) }))

  const patch: ExportPatch[] = [
    ...profile.bundles.flatMap((bundle) => bundle.patch.flatMap((entry) => exportPatch(entry))),
    ...profile.patch.flatMap((entry) => (isInsert(entry) || isRuntimeRowId(entry.id) ? [] : exportPatch(entry))),
  ]

  const requires = [...new Set(profile.bundles.flatMap((bundle) => bundle.requires))]

  return toJson({ name: packageName, version, keywords: ["xin-plugin"], xin: { bundle: bundleRows, patch, requires } })
}

function fail(message: string): never {
  throw new OpRejected("bad_args", message)
}

export const name = "profiles"
export const inject = ["host", "kernel", "ops", "packages"]

export function apply(ctx: Context): void {
  const storage = ctx.host.state.storage
  const warn = (message: string): void => {
    if (!ctx.kernel.warnings.includes(message)) ctx.kernel.warnings.push(message)
  }
  const createDefault = (): ProfilesState => {
    const bundles = readBundles(storage, warn).map((entry) => entry.bundle)
    const patch = readOwnerPatch(storage, warn)
    return { active: DEFAULT_PROFILE, bundles, patch, profiles: { [DEFAULT_PROFILE]: { bundles, patch } } }
  }
  const loaded = readState(storage)
  let state: ProfilesState
  if (loaded.kind === "ok") state = loaded.state
  else {
    if (loaded.kind === "invalid") warn(loaded.message)
    state = createDefault()
    if (loaded.kind === "absent") writeState(storage, state)
  }

  const store = (next: ProfilesState): ProfilesState => {
    state = next
    writeState(storage, next)
    return next
  }

  const list = (): JsonValue => {
    const profiles = Object.keys(state.profiles)
      .toSorted()
      .map((profileName) => ({
        name: profileName,
        bundles: (state.profiles[profileName]?.bundles ?? []).map((bundle) => bundle.package),
      }))
    return toJson({ active: state.active, profiles })
  }

  const save = (profileName: string): Promise<JsonValue> =>
    ctx.packages.queue(async () => {
      const bundles = readBundles(storage, () => undefined).map((entry) => entry.bundle)
      const patch = ctx.kernel.ownerPatch()
      store({
        active: state.active,
        bundles,
        patch,
        profiles: { ...state.profiles, [profileName]: { bundles, patch } },
      })
      return toJson({ application: "applied", name: profileName, active: state.active })
    })

  const switchTo = (profileName: string): Promise<JsonValue> =>
    ctx.packages.queue(async () => {
      const profile = state.profiles[profileName]
      if (profile === undefined) fail(`no profile ${profileName}`)
      const previous = state
      store({ active: profileName, bundles: profile.bundles, patch: profile.patch, profiles: previous.profiles })
      let applied = false
      try {
        const application = await ctx.packages.replaceNow(profile.bundles, profile.patch)
        applied = application.application === "applied"
        return toJson({ ...application, name: profileName })
      } finally {
        if (!applied) store(previous)
      }
    })

  const remove = (profileName: string): Promise<JsonValue> =>
    ctx.packages.queue(async () => {
      if (state.profiles[profileName] === undefined) fail(`no profile ${profileName}`)
      if (profileName === state.active) fail(`profile ${profileName} is active and cannot be deleted`)
      const profiles = { ...state.profiles }
      delete profiles[profileName]
      const bundles = readBundles(storage, () => undefined).map((entry) => entry.bundle)
      store({ active: state.active, bundles, patch: ctx.kernel.ownerPatch(), profiles })
      return toJson({ application: "applied", name: profileName })
    })

  const exportProfile = (profileName: string | undefined, packageName: string, version: string): JsonValue => {
    if (!isPackageName(packageName)) fail(`${packageName} is not a valid package name`)
    const profile = profileName === undefined ? undefined : state.profiles[profileName]
    if (profileName !== undefined && profile === undefined) fail(`no profile ${profileName}`)
    const source: StoredProfile = profile ?? {
      bundles: readBundles(storage, () => undefined).map((entry) => entry.bundle),
      patch: ctx.kernel.ownerPatch(),
    }
    return manifestOf(
      source,
      (plugin) => ctx.kernel.composition.catalog[plugin]?.multiple === true,
      packageName,
      version,
    )
  }

  ctx.ops.define(defineOp({ name: "profile.list", args: obj({}), actors: OWNER, run: async () => list() }))
  ctx.ops.define(
    defineOp({
      name: "profile.save",
      args: obj({ name: FragmentId }),
      actors: OWNER,
      run: async (_api, args) => save(args.name),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "profile.switch",
      args: obj({ name: FragmentId }),
      actors: OWNER,
      run: async (_api, args) => switchTo(args.name),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "profile.delete",
      args: obj({ name: FragmentId }),
      actors: OWNER,
      run: async (_api, args) => remove(args.name),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "profile.export",
      args: obj({ name: opt(FragmentId), package: PluginArg, version: VersionArg }),
      actors: OWNER,
      run: async (_api, args) => exportProfile(args.name, args.package, args.version),
    }),
  )
}
