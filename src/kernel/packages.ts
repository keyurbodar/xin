import type { Context } from "@deepseek-ai/cordis"
import type { JsonValue } from "@earendil-works/chord"
import { arr, compile, lit, obj, opt, str, union } from "@earendil-works/pi-schema"
import { isPackageName, MAX_PACKAGE_NAME } from "../npmname.ts"
import { defineOp, OpRejected } from "../ops.ts"
import { satisfies } from "../semver.ts"
import {
  BundlePatchArg,
  BundleRowArg,
  createBundles,
  normalizePatch,
  normalizeRow,
  type BundleApplication,
  type BundleView,
  type RuntimeBundle,
} from "./bundles.ts"
import type { Catalog } from "./loader.ts"

declare const XIN_BUILD: string | undefined

export type PackageSpec =
  | { readonly kind: "registry"; readonly name: string; readonly range?: string }
  | { readonly kind: "git"; readonly url: string; readonly ref?: string; readonly path?: string }

export type PendingPackages = { readonly add: readonly string[]; readonly remove: readonly string[] }

export type InstalledPackage = { readonly package: string; readonly version: string }

export type Packages = {
  readonly installed: readonly InstalledPackage[]
  readonly pending: PendingPackages
}

export type PackagesChanged = Packages & { readonly application: "applied" }

export type PackagesService = {
  readonly version: string
  readonly local: readonly string[]
  list(): Packages
  pending(): PendingPackages
  install(spec: string): PendingPackages
  cancel(name: string): PendingPackages
  bundles(): Promise<readonly BundleView[]>
  put(bundle: RuntimeBundle): Promise<BundleApplication>
  remove(name: string): Promise<{ readonly application: "applied"; readonly package: string }>
}

export type AddEntry = { readonly spec: PackageSpec; readonly build: string; readonly name?: string }

export type RemoveEntry = { readonly name: string; readonly build: string }

export type StoredPending = { readonly add: readonly AddEntry[]; readonly remove: readonly RemoveEntry[] }

const PENDING_KEY = "plugins.packages"
const OWNER = ["owner"] as const

const REGISTRY_RANGE = /^[A-Za-z0-9.^~><=*xX|-]+$/
const GITHUB_SPEC = /^github:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:#([A-Za-z0-9._+/-]+))?$/
const GIT_URL = /^(?:git\+)?https:\/\//i
const REF = /^[A-Za-z0-9._+/-]+$/
const GIT_SEGMENT = /^[A-Za-z0-9._@+-]+$/
const PATH_PARAM = "&path:/"
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const MAX_SPEC = MAX_PACKAGE_NAME + 64

const SpecSchema = union([
  obj({ kind: lit("registry"), name: str({ minLength: 1 }), range: opt(str({ minLength: 1 })) }),
  obj({
    kind: lit("git"),
    url: str({ minLength: 1 }),
    ref: opt(str({ minLength: 1 })),
    path: opt(str({ minLength: 1 })),
  }),
])
const StoredSchema = obj({
  add: arr(obj({ spec: SpecSchema, build: str(), name: opt(str()) })),
  remove: arr(obj({ name: str(), build: str() })),
})
const storedCheck = compile(StoredSchema)

const SpecArg = str({ minLength: 1, maxLength: MAX_SPEC })
const PackageArg = str({ minLength: 1, maxLength: MAX_PACKAGE_NAME })

export const buildId = (): string => (typeof XIN_BUILD === "string" ? XIN_BUILD : "dev")

export function parseSpec(text: string): PackageSpec | undefined {
  if (text.length === 0 || text.length > MAX_SPEC) return undefined
  if (text.startsWith("github:")) return parseGithub(text)
  if (GIT_URL.test(text)) return parseGitUrl(text)
  if (SCHEME.test(text)) return undefined
  return parseRegistry(text)
}

function parseGithub(text: string): PackageSpec | undefined {
  const match = GITHUB_SPEC.exec(text)
  const owner = match?.[1]
  const repo = match?.[2]
  if (match === null || owner === undefined || repo === undefined) return undefined
  const ref = match[3]
  return { kind: "git", url: `github:${owner}/${repo}`, ...(ref === undefined ? {} : { ref }) }
}

const validPath = (path: string): boolean =>
  path.length > 0 &&
  path.split("/").every((segment) => segment !== "." && segment !== ".." && GIT_SEGMENT.test(segment))

function parseGitUrl(text: string): PackageSpec | undefined {
  const hash = text.indexOf("#")
  const base = hash === -1 ? text : text.slice(0, hash)
  const fragment = hash === -1 ? undefined : text.slice(hash + 1)
  let ref: string | undefined
  let path: string | undefined
  if (fragment !== undefined) {
    const marker = fragment.indexOf(PATH_PARAM)
    ref = marker === -1 ? fragment : fragment.slice(0, marker)
    path = marker === -1 ? undefined : fragment.slice(marker + PATH_PARAM.length)
    if (!REF.test(ref)) return undefined
    if (path !== undefined && !validPath(path)) return undefined
  }
  if (!base.endsWith(".git")) return undefined
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "git+https:") return undefined
  if (url.hostname === "" || url.username !== "" || url.password !== "" || url.search !== "") return undefined
  if (!url.pathname.endsWith(".git") || url.pathname === ".git") return undefined
  return { kind: "git", url: base, ...(ref === undefined ? {} : { ref }), ...(path === undefined ? {} : { path }) }
}

function parseRegistry(text: string): PackageSpec | undefined {
  const at = text.lastIndexOf("@")
  const name = at > 0 ? text.slice(0, at) : text
  const range = at > 0 ? text.slice(at + 1) : undefined
  if (!isPackageName(name)) return undefined
  if (range !== undefined && !REGISTRY_RANGE.test(range)) return undefined
  return { kind: "registry", name, ...(range === undefined ? {} : { range }) }
}

export const specText = (spec: PackageSpec): string => {
  if (spec.kind === "registry") return spec.range === undefined ? spec.name : `${spec.name}@${spec.range}`
  if (spec.ref === undefined) return spec.url
  return `${spec.url}#${spec.path === undefined ? spec.ref : `${spec.ref}&path:/${spec.path}`}`
}

export const specId = (spec: PackageSpec): string => (spec.kind === "registry" ? spec.name : spec.url)

export function sourcePackage(source: string): string {
  const at = source.lastIndexOf("@")
  return at > 0 ? source.slice(0, at) : source
}

export function installedPackages(catalog: Catalog): readonly InstalledPackage[] {
  const versions = new Map<string, string>()
  for (const entry of Object.values(catalog)) {
    const name = sourcePackage(entry.source)
    const at = entry.source.lastIndexOf("@")
    const version = at > 0 ? entry.source.slice(at + 1) : "dev"
    if (!versions.has(name) || versions.get(name) === "dev") versions.set(name, version)
  }
  return [...versions]
    .map(([name, version]) => ({ package: name, version }))
    .toSorted((left, right) => left.package.localeCompare(right.package))
}

export function localPackages(catalog: Catalog): readonly string[] {
  const locals = new Map<string, boolean>()
  for (const entry of Object.values(catalog)) {
    const name = sourcePackage(entry.source)
    const local = entry.local === true
    locals.set(name, (locals.get(name) ?? true) && local)
  }
  return [...locals]
    .filter(([, local]) => local)
    .map(([name]) => name)
    .toSorted()
}

export function readPending(storage: DurableObjectStorage): StoredPending {
  const value: unknown = storage.kv.get(PENDING_KEY)
  return storedCheck.check(value) ? value : { add: [], remove: [] }
}

export function writePending(storage: DurableObjectStorage, pending: StoredPending): void {
  if (pending.add.length === 0 && pending.remove.length === 0) storage.kv.delete(PENDING_KEY)
  else storage.kv.put(PENDING_KEY, { add: [...pending.add], remove: [...pending.remove] })
}

export const pendingWire = (pending: StoredPending): PendingPackages => ({
  add: pending.add.map((entry) => specText(entry.spec)),
  remove: pending.remove.map((entry) => entry.name),
})

export function reconcilePending(pending: StoredPending, catalog: Catalog, build: string): StoredPending {
  const versions = new Map(installedPackages(catalog).map((entry) => [entry.package, entry.version]))
  return {
    add: pending.add.filter((entry) => keepAdd(entry, versions, build)),
    remove: pending.remove.filter((entry) => entry.build === build || versions.has(entry.name)),
  }
}

function keepAdd(entry: AddEntry, versions: ReadonlyMap<string, string>, build: string): boolean {
  if (entry.build === build) return true
  if (entry.spec.kind === "registry") {
    const version = versions.get(entry.spec.name)
    if (version === undefined) return true
    return entry.spec.range === undefined ? false : !satisfies(version, entry.spec.range)
  }
  return entry.name !== undefined && !versions.has(entry.name)
}

function addPending(storage: DurableObjectStorage, spec: PackageSpec): StoredPending {
  const pending = readPending(storage)
  const id = specId(spec)
  const entry: AddEntry = { spec, build: buildId() }
  const add = pending.add.some((candidate) => specId(candidate.spec) === id)
    ? pending.add.map((candidate) => (specId(candidate.spec) === id ? entry : candidate))
    : [...pending.add, entry]
  const next: StoredPending = { add, remove: pending.remove.filter((candidate) => candidate.name !== id) }
  writePending(storage, next)
  return next
}

function removePending(catalog: Catalog, storage: DurableObjectStorage, pkg: string): StoredPending {
  const entries = Object.values(catalog).filter((entry) => sourcePackage(entry.source) === pkg)
  if (entries.length === 0) throw new OpRejected("bad_args", `${pkg} is not in this build`)
  if (entries.some((entry) => entry.required === true))
    throw new OpRejected("bad_args", `${pkg} provides core and cannot be removed`)
  if (entries.some((entry) => entry.local === true))
    throw new OpRejected("bad_args", `${pkg} is a local package; disable its bundle instead`)
  const pending = readPending(storage)
  const remove = pending.remove.some((entry) => entry.name === pkg)
    ? pending.remove
    : [...pending.remove, { name: pkg, build: buildId() }]
  const next: StoredPending = { add: pending.add.filter((entry) => specId(entry.spec) !== pkg), remove }
  writePending(storage, next)
  return next
}

function cancelPending(storage: DurableObjectStorage, name: string): StoredPending {
  const pending = readPending(storage)
  const next: StoredPending = {
    add: pending.add.filter((entry) => (entry.spec.kind === "registry" ? entry.spec.name : entry.name) !== name),
    remove: pending.remove.filter((entry) => entry.name !== name),
  }
  writePending(storage, next)
  return next
}

export const toJson = (value: unknown): JsonValue => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

const BundleArgs = obj({
  package: PackageArg,
  rows: arr(BundleRowArg),
  patch: opt(arr(BundlePatchArg)),
  requires: opt(arr(str({ minLength: 1, maxLength: MAX_SPEC }))),
})

type BundleArgsValue = {
  readonly package: string
  readonly rows: readonly {
    readonly id: string
    readonly plugin: string
    readonly config?: unknown
    readonly disabled?: boolean
  }[]
  readonly patch?: readonly {
    readonly id: string
    readonly config?: unknown
    readonly disabled?: boolean
  }[]
  readonly requires?: readonly string[]
}

const localBundle = (args: BundleArgsValue): RuntimeBundle => ({
  package: args.package,
  source: { kind: "local" },
  rows: args.rows.map((row) =>
    normalizeRow({ id: row.id, plugin: row.plugin, config: toJson(row.config), disabled: row.disabled }),
  ),
  patch: (args.patch ?? []).map((entry) =>
    normalizePatch({ id: entry.id, config: toJson(entry.config), disabled: entry.disabled }),
  ),
  requires: [...(args.requires ?? [])],
})

declare module "@deepseek-ai/cordis" {
  interface Context {
    packages: PackagesService
  }
}

export const name = "packages"
export const inject = ["host", "http", "kernel", "ops"]

export function apply(ctx: Context): void {
  const storage = ctx.host.state.storage
  const catalog = ctx.kernel.composition.catalog
  const bundles = createBundles(ctx.kernel, storage, {
    validName: isPackageName,
    parse: parseSpec,
    record: (spec) => void addPending(storage, spec),
    cancel: (pkg) => void cancelPending(storage, pkg),
  })
  const view = (): Packages => {
    const pending = readPending(storage)
    return { installed: installedPackages(catalog), pending: pendingWire(pending) }
  }
  const service: PackagesService = {
    version: ctx.kernel.composition.version,
    local: localPackages(catalog),
    list: view,
    pending: () => view().pending,
    install: (spec) => {
      const parsed = parseSpec(spec)
      if (parsed === undefined) throw new OpRejected("bad_args", `${spec} is not a supported package spec`)
      return pendingWire(addPending(storage, parsed))
    },
    cancel: (pkg) => pendingWire(cancelPending(storage, pkg)),
    bundles: () => bundles.list(),
    put: (bundle) => bundles.put(bundle),
    remove: (pkg) => bundles.remove(pkg),
  }
  writePending(storage, reconcilePending(readPending(storage), catalog, buildId()))
  ctx.provide("packages", service)
  ctx.http.route("GET /v1/build/packages", async () => Response.json(service.pending()))
  ctx.ops.define(
    defineOp({
      name: "plugin.packages",
      args: obj({}),
      actors: OWNER,
      run: async () => toJson({ ...view(), bundles: await bundles.list() }),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "bundle.list",
      args: obj({}),
      actors: OWNER,
      run: async () => toJson(await bundles.list()),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "bundle.put",
      args: BundleArgs,
      actors: OWNER,
      run: async (_api, args) => toJson(await bundles.put(localBundle(args))),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "bundle.remove",
      args: obj({ package: PackageArg }),
      actors: OWNER,
      run: async (_api, args) => toJson(await bundles.remove(args.package)),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.install",
      args: obj({ spec: SpecArg }),
      actors: OWNER,
      run: async (_api, args) => {
        const spec = parseSpec(args.spec)
        if (spec === undefined) throw new OpRejected("bad_args", `${args.spec} is not a supported package spec`)
        addPending(storage, spec)
        return toJson({ application: "applied", ...view() })
      },
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.uninstall",
      args: obj({ package: PackageArg }),
      actors: OWNER,
      run: async (_api, args) => {
        removePending(catalog, storage, args.package)
        return toJson({ application: "applied", ...view() })
      },
    }),
  )
}
