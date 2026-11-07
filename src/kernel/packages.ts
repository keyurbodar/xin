import type { Context } from "@deepseek-ai/cordis"
import type { JsonValue } from "@earendil-works/chord"
import { arr, compile, lit, obj, opt, str, union } from "@earendil-works/pi-schema"
import { defineOp, OpRejected } from "../ops.ts"
import type { Catalog } from "./loader.ts"

declare const XIN_BUILD: string | undefined

export type PackageSpec =
  | { readonly kind: "registry"; readonly name: string; readonly range?: string }
  | { readonly kind: "git"; readonly url: string; readonly ref?: string }

export type PendingPackages = { readonly add: readonly string[]; readonly remove: readonly string[] }

export type InstalledPackage = { readonly package: string; readonly version: string }

export type Packages = {
  readonly installed: readonly InstalledPackage[]
  readonly pending: PendingPackages
}

export type PackagesChanged = Packages & { readonly application: "applied" }

export type PackagesService = {
  list(): Packages
  pending(): PendingPackages
}

export type AddEntry = { readonly spec: PackageSpec; readonly build: string; readonly name?: string }

export type RemoveEntry = { readonly name: string; readonly build: string }

export type StoredPending = { readonly add: readonly AddEntry[]; readonly remove: readonly RemoveEntry[] }

const PENDING_KEY = "plugins.packages"
const OWNER = ["owner"] as const

const REGISTRY_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/
const REGISTRY_RANGE = /^[A-Za-z0-9.^~><=*xX|-]+$/
const GITHUB_SPEC = /^github:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:#([A-Za-z0-9._+/-]+))?$/
const GIT_URL = /^(?:git\+)?https:\/\//i
const REF = /^[A-Za-z0-9._+/-]+$/
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

const SpecSchema = union([
  obj({ kind: lit("registry"), name: str({ minLength: 1 }), range: opt(str({ minLength: 1 })) }),
  obj({ kind: lit("git"), url: str({ minLength: 1 }), ref: opt(str({ minLength: 1 })) }),
])
const StoredSchema = obj({
  add: arr(obj({ spec: SpecSchema, build: str(), name: opt(str()) })),
  remove: arr(obj({ name: str(), build: str() })),
})
const storedCheck = compile(StoredSchema)

const SpecArg = str({ minLength: 1, maxLength: 200 })
const PackageArg = str({ minLength: 1, maxLength: 200 })

export const buildId = (): string => (typeof XIN_BUILD === "string" ? XIN_BUILD : "dev")

export function parseSpec(text: string): PackageSpec | undefined {
  if (text.length === 0 || text.length > 200) return undefined
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

function parseGitUrl(text: string): PackageSpec | undefined {
  const hash = text.indexOf("#")
  const base = hash === -1 ? text : text.slice(0, hash)
  const ref = hash === -1 ? undefined : text.slice(hash + 1)
  if (ref !== undefined && !REF.test(ref)) return undefined
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
  return { kind: "git", url: base, ...(ref === undefined ? {} : { ref }) }
}

function parseRegistry(text: string): PackageSpec | undefined {
  const at = text.lastIndexOf("@")
  const name = at > 0 ? text.slice(0, at) : text
  const range = at > 0 ? text.slice(at + 1) : undefined
  if (!REGISTRY_NAME.test(name)) return undefined
  if (range !== undefined && !REGISTRY_RANGE.test(range)) return undefined
  return { kind: "registry", name, ...(range === undefined ? {} : { range }) }
}

export const specText = (spec: PackageSpec): string =>
  spec.kind === "registry"
    ? spec.range === undefined
      ? spec.name
      : `${spec.name}@${spec.range}`
    : spec.ref === undefined
      ? spec.url
      : `${spec.url}#${spec.ref}`

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
    return entry.spec.range === undefined ? false : !rangeMatches(version, entry.spec.range)
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

const toJson = (value: unknown): JsonValue => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

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
  const view = (): Packages => {
    const pending = readPending(storage)
    return { installed: installedPackages(catalog), pending: pendingWire(pending) }
  }
  const service: PackagesService = { list: view, pending: () => view().pending }
  writePending(storage, reconcilePending(readPending(storage), catalog, buildId()))
  ctx.provide("packages", service)
  ctx.http.route("GET /v1/build/packages", async () => Response.json(service.pending()))
  ctx.ops.define(
    defineOp({
      name: "plugin.packages",
      args: obj({}),
      actors: OWNER,
      run: async () => toJson(view()),
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

function rangeMatches(version: string, range: string): boolean {
  const built = versionTuple(version)
  if (built === undefined) return false
  return range.split("||").some((alternative) => inAlternative(built, alternative.trim()))
}

type Tuple = readonly [number, number, number]

function versionTuple(text: string): Tuple | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(text)
  const major = match?.[1]
  if (match === null || major === undefined) return undefined
  return [Number(major), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function inAlternative(version: Tuple, text: string): boolean {
  if (text === "" || text === "*" || text === "x" || text === "X") return true
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(text)
  const op = match?.[1] ?? ""
  const body = match?.[2]
  if (body === undefined) return false
  const parts = body.split(".")
  if (parts.length > 3) return false
  const major = parts[0]
  if (major === undefined) return false
  const tuple: Tuple = [Number(major), Number(parts[1] ?? "0"), Number(parts[2] ?? "0")]
  if (tuple.some((part) => Number.isNaN(part))) return false
  const atLeast = compare(version, tuple) >= 0
  switch (op) {
    case "^": {
      const upper: Tuple =
        tuple[0] > 0 || parts.length === 1
          ? [tuple[0] + 1, 0, 0]
          : tuple[1] > 0 || parts.length === 2
            ? [0, tuple[1] + 1, 0]
            : [0, 0, tuple[2] + 1]
      return atLeast && compare(version, upper) < 0
    }
    case "~": {
      const upper: Tuple = parts.length === 1 ? [tuple[0] + 1, 0, 0] : [tuple[0], tuple[1] + 1, 0]
      return atLeast && compare(version, upper) < 0
    }
    case ">=":
      return atLeast
    case ">":
      return compare(version, tuple) > 0
    case "<=":
      return !(compare(version, tuple) > 0)
    case "<":
      return compare(version, tuple) < 0
    default:
      return matchesPrefix(version, tuple, parts.length)
  }
}

function matchesPrefix(version: Tuple, tuple: Tuple, length: number): boolean {
  if (length === 1) return version[0] === tuple[0]
  if (length === 2) return version[0] === tuple[0] && version[1] === tuple[1]
  return compare(version, tuple) === 0
}

function compare(left: Tuple, right: Tuple): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}
