import {
  arr,
  compile,
  lit,
  map,
  obj,
  opt,
  str,
  unknown,
  type Static,
  type ValidationError,
} from "@earendil-works/pi-schema"
import { isPackageName } from "../../src/npmname.ts"

export const ABBREVIATED_ACCEPT = "application/vnd.npm.install-v1+json"
export const REQUEST_TIMEOUT_MS = 10_000

export type RegistryDist = { readonly tarball: string; readonly integrity?: string }
export type RegistryEngines = { readonly xin?: string }

export type RegistryVersion = {
  readonly version: string
  readonly deprecated?: string
  readonly engines?: RegistryEngines
  readonly dist: RegistryDist
}

export type Abbreviated = {
  readonly name: string
  readonly distTags: Readonly<Record<string, string>>
  readonly versions: readonly RegistryVersion[]
  readonly time?: Readonly<Record<string, string>>
}

export type VersionDocument = {
  readonly name: string
  readonly version: string
  readonly xin?: unknown
  readonly readme?: string
  readonly deprecated?: string
  readonly engines?: RegistryEngines
  readonly dist: RegistryDist
}

export type SearchHit = {
  readonly name: string
  readonly description?: string
}

export type IndexEntry = {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly icon?: string
  readonly author?: string
  readonly repository?: string
  readonly metadata?: {
    readonly categories?: readonly string[]
    readonly labels?: readonly string[]
  }
}

export type RegistryFailure =
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "http"; readonly status: number; readonly message: string }
  | { readonly kind: "parse"; readonly message: string }
  | { readonly kind: "input"; readonly message: string }

export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RegistryFailure }

export type Registry = {
  abbreviated(name: string): Promise<RegistryResult<Abbreviated>>
  version(name: string, version: string): Promise<RegistryResult<VersionDocument>>
  search(text: string): Promise<RegistryResult<readonly SearchHit[]>>
  index(url: string): Promise<RegistryResult<readonly IndexEntry[]>>
}

export type RegistryOptions = {
  readonly fetch: typeof fetch
  readonly baseUrl: string
  readonly timeoutMs?: number
}

const DistSchema = obj({ tarball: str({ minLength: 1 }), integrity: opt(str({ minLength: 1 })) }, { open: true })
const EnginesSchema = obj({ xin: opt(str({ minLength: 1 })) }, { open: true })

const AbbreviatedSchema = obj(
  {
    name: str({ minLength: 1 }),
    "dist-tags": opt(map(str())),
    versions: map(obj({ deprecated: opt(str()), engines: opt(EnginesSchema), dist: DistSchema }, { open: true })),
    time: opt(map(str())),
  },
  { open: true },
)

const VersionDocumentSchema = obj(
  {
    name: str({ minLength: 1 }),
    version: str({ minLength: 1 }),
    xin: opt(unknown()),
    readme: opt(str()),
    deprecated: opt(str()),
    engines: opt(EnginesSchema),
    dist: DistSchema,
  },
  { open: true },
)

const SearchSchema = obj(
  {
    objects: arr(
      obj({ package: obj({ name: str({ minLength: 1 }), description: opt(str()) }, { open: true }) }, { open: true }),
    ),
  },
  { open: true },
)

const MetadataSchema = obj({ categories: opt(arr(str())), labels: opt(arr(str())) }, { open: true })

const IndexEntrySchema = obj(
  {
    name: str({ minLength: 1 }),
    title: opt(str()),
    description: opt(str()),
    icon: opt(str()),
    author: opt(str()),
    repository: opt(str()),
    metadata: opt(MetadataSchema),
  },
  { open: true },
)

const IndexSchema = obj({ format: lit(1), packages: arr(IndexEntrySchema) }, { open: true })

const abbreviatedCheck = compile(AbbreviatedSchema)
const versionCheck = compile(VersionDocumentSchema)
const searchCheck = compile(SearchSchema)
const indexCheck = compile(IndexSchema)

const VERSION_OR_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

export function registry(options: RegistryOptions): Registry {
  const base = options.baseUrl.replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const request = (url: string, accept: string): Promise<RegistryResult<unknown>> =>
    get(options.fetch, url, accept, timeoutMs)

  return {
    async abbreviated(name) {
      const path = packagePath(name)
      if (path === undefined) return badName(name)
      const found = await request(`${base}/${path}`, ABBREVIATED_ACCEPT)
      if (!found.ok) return found
      if (!abbreviatedCheck.check(found.value)) return badDocument(abbreviatedCheck.errors(found.value))
      const document = found.value
      return {
        ok: true,
        value: {
          name: document.name,
          distTags: document["dist-tags"] ?? {},
          versions: Object.entries(document.versions).map(([version, entry]) => ({
            version,
            ...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
            ...(entry.engines === undefined ? {} : { engines: plainEngines(entry.engines) }),
            dist: plainDist(entry.dist),
          })),
          ...(document.time === undefined ? {} : { time: document.time }),
        },
      }
    },

    async version(name, version) {
      const path = packagePath(name)
      if (path === undefined) return badName(name)
      if (!VERSION_OR_TAG.test(version)) return badInput(`invalid version ${version}`)
      const found = await request(`${base}/${path}/${version}`, "application/json")
      if (!found.ok) return found
      if (!versionCheck.check(found.value)) return badDocument(versionCheck.errors(found.value))
      const document = found.value
      return {
        ok: true,
        value: {
          name: document.name,
          version: document.version,
          dist: plainDist(document.dist),
          ...(document.xin === undefined ? {} : { xin: document.xin }),
          ...(document.readme === undefined ? {} : { readme: document.readme }),
          ...(document.deprecated === undefined ? {} : { deprecated: document.deprecated }),
          ...(document.engines === undefined ? {} : { engines: plainEngines(document.engines) }),
        },
      }
    },

    async search(text) {
      const query = new URLSearchParams({ text: `keywords:xin-plugin${text.trim() === "" ? "" : ` ${text.trim()}`}` })
      const found = await request(`${base}/-/v1/search?${query.toString()}`, "application/json")
      if (!found.ok) return found
      if (!searchCheck.check(found.value)) return badDocument(searchCheck.errors(found.value))
      return {
        ok: true,
        value: found.value.objects.map(({ package: hit }) => ({
          name: hit.name,
          ...(hit.description === undefined ? {} : { description: hit.description }),
        })),
      }
    },

    async index(url) {
      const parsed = absoluteUrl(url)
      if (parsed === undefined) return badInput(`invalid index url ${url}`)
      const found = await request(parsed, "application/json")
      if (!found.ok) return found
      if (!indexCheck.check(found.value)) return badDocument(indexCheck.errors(found.value))
      return { ok: true, value: found.value.packages.map(plainIndexEntry) }
    },
  }
}

function plainDist(dist: { readonly tarball: string; readonly integrity?: string }): RegistryDist {
  return { tarball: dist.tarball, ...(dist.integrity === undefined ? {} : { integrity: dist.integrity }) }
}

function plainEngines(engines: { readonly xin?: string }): RegistryEngines {
  return engines.xin === undefined ? {} : { xin: engines.xin }
}

function packagePath(name: string): string | undefined {
  return isPackageName(name) ? name.replace("/", "%2f") : undefined
}

function absoluteUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" ? parsed.href : undefined
  } catch {
    return undefined
  }
}

type ParsedIndexEntry = Static<typeof IndexEntrySchema>

function plainIndexEntry(entry: ParsedIndexEntry): IndexEntry {
  const metadata = entry.metadata
  return {
    name: entry.name,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    ...(entry.author === undefined ? {} : { author: entry.author }),
    ...(entry.repository === undefined ? {} : { repository: entry.repository }),
    ...(metadata === undefined
      ? {}
      : {
          metadata: {
            ...(metadata.categories === undefined ? {} : { categories: metadata.categories }),
            ...(metadata.labels === undefined ? {} : { labels: metadata.labels }),
          },
        }),
  }
}

async function get(
  fetchImpl: typeof fetch,
  url: string,
  accept: string,
  timeoutMs: number,
): Promise<RegistryResult<unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const pending = fetchImpl(url, { headers: { accept }, signal: controller.signal })
    const response = await untilAborted(pending, controller.signal)
    if (!response.ok) {
      return { ok: false, error: { kind: "http", status: response.status, message: `HTTP ${response.status}` } }
    }
    return { ok: true, value: await untilAborted(response.json(), controller.signal) }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: { kind: "timeout", message: "request timed out" } }
    if (error instanceof SyntaxError) return { ok: false, error: { kind: "parse", message: messageOf(error) } }
    return { ok: false, error: requestFailure(error) }
  } finally {
    clearTimeout(timer)
  }
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function requestFailure(error: unknown): RegistryFailure {
  const name = error instanceof Error ? error.name : ""
  if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout", message: messageOf(error) }
  return { kind: "network", message: messageOf(error) }
}

function badDocument(errors: readonly ValidationError[]): RegistryResult<never> {
  const details = errors
    .slice(0, 3)
    .map((error) => `${error.path}: ${error.message}`)
    .join("; ")
  return { ok: false, error: { kind: "parse", message: details === "" ? "invalid document" : details } }
}

function badName(name: string): RegistryResult<never> {
  return badInput(`invalid package name ${name}`)
}

function badInput(message: string): RegistryResult<never> {
  return { ok: false, error: { kind: "input", message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
