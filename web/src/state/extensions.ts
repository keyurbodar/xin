import { createSignal } from "solid-js"
import { cmd, OpError } from "../lib/api.ts"
import { isRecord, listOf, numOf, strOf } from "../lib/parse.ts"

export { isRecord }


export type Remote<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "failed"; readonly message: string }

export type Layer = "bundle" | "runtime" | "profile" | "owner"

export type RowStateKind = "active" | "pending" | "disabled" | "failed" | "missing"

export type RowState = { readonly kind: RowStateKind; readonly error?: string | undefined }

export type PluginRow = {
  readonly id: string
  readonly plugin: string
  readonly title: string
  readonly required: boolean
  readonly layer: Layer
  readonly disabled: boolean
  readonly config: Readonly<Record<string, unknown>>
  readonly state: RowState
}

export type CatalogEntry = {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly required: boolean
  readonly source: string
  readonly schema: unknown
}

export type BundleSource =
  | { readonly kind: "registry"; readonly version: string }
  | { readonly kind: "local" }

export type BundleRowView = { readonly id: string; readonly state: RowState }

export type BundleView = {
  readonly package: string
  readonly source: BundleSource
  readonly requires: readonly string[]
  readonly rows: readonly BundleRowView[]
  readonly patch: readonly string[]
}

export type PendingPackages = { readonly add: readonly string[]; readonly remove: readonly string[] }

export type Packages = {
  readonly installed: readonly { readonly package: string; readonly version: string }[]
  readonly pending: PendingPackages
  readonly bundles: readonly BundleView[]
}

export type MarketStatus = "not-installed" | "installed" | "update-available" | "different-version" | "provided"

export type MarketSummary = {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly author?: string | undefined
  readonly category?: string | undefined
  readonly homepage?: string | undefined
  readonly repository?: string | undefined
  readonly status: MarketStatus
  readonly skipped: boolean
}

export type MarketVersion = {
  readonly version: string
  readonly publishTimestamp?: number | undefined
  readonly compatible: boolean
  readonly skipped: boolean
}

export type MarketDeclaration = {
  readonly id: string
  readonly plugin: string
  readonly config: unknown
  readonly disabled: boolean
}

export type MarketDetail = {
  readonly name: string
  readonly kind: "bundle" | "code" | undefined
  readonly status: MarketStatus
  readonly versions: readonly MarketVersion[]
  readonly readme?: string | undefined
  readonly requires: readonly string[]
  readonly rows: readonly MarketDeclaration[]
}

export type InstallResult = {
  readonly application: "applied" | "pending" | "failed"
  readonly package: string
  readonly version?: string | undefined
  readonly kind?: string | undefined
  readonly rows: readonly { readonly id: string; readonly error?: string | undefined }[]
}

export type SkillRow = { readonly name: string; readonly description: string }

export type PresetRow = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly plugins: "all" | readonly string[]
  readonly isDefault: boolean
}

export type McpServer = {
  readonly name: string
  readonly url: string
  readonly tools: number
  readonly error?: string | undefined
  readonly source?: string | undefined
}


const boolOf = (value: unknown): boolean => value === true

const records = (value: unknown): readonly Readonly<Record<string, unknown>>[] => listOf(value).filter(isRecord)

const localized = (value: unknown): string | undefined => {
  const direct = strOf(value)
  if (direct !== undefined) return direct
  if (!isRecord(value)) return undefined
  const english = strOf(value["en"])
  if (english !== undefined) return english
  for (const entry of Object.values(value)) {
    const found = strOf(entry)
    if (found !== undefined) return found
  }
  return undefined
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong"

export type RemoteHandle<T> = {
  readonly state: () => Remote<T>
  readonly reload: () => Promise<void>
}

export function remote<T>(load: () => Promise<unknown>, parse: (value: unknown) => T): RemoteHandle<T> {
  const [state, setState] = createSignal<Remote<T>>({ kind: "loading" })
  let inflight: Promise<void> | undefined
  const reload = (): Promise<void> => {
    if (inflight !== undefined) return inflight
    const started = load()
      .then((value) => {
        setState({ kind: "ready", value: parse(value) })
      })
      .catch((error: unknown) => {
        setState({ kind: "failed", message: errorMessage(error) })
      })
      .finally(() => {
        inflight = undefined
      })
    inflight = started
    return started
  }
  return { state, reload }
}


function layerOf(value: unknown): Layer {
  switch (value) {
    case "runtime":
      return "runtime"
    case "profile":
      return "profile"
    case "owner":
      return "owner"
    default:
      return "bundle"
  }
}

export function rowStateOf(value: unknown): RowState {
  if (!isRecord(value)) return { kind: "pending" }
  const error = strOf(value["error"])
  switch (value["kind"]) {
    case "active":
      return { kind: "active" }
    case "disabled":
      return { kind: "disabled" }
    case "failed":
      return { kind: "failed", error: error ?? "failed" }
    case "missing":
      return { kind: "missing" }
    default:
      return { kind: "pending" }
  }
}

function parseRow(item: Readonly<Record<string, unknown>>): PluginRow | undefined {
  const id = strOf(item["id"])
  const plugin = strOf(item["plugin"])
  if (id === undefined || plugin === undefined) return undefined
  const config = item["config"]
  return {
    id,
    plugin,
    title: strOf(item["title"]) ?? plugin,
    required: boolOf(item["required"]),
    layer: layerOf(item["layer"]),
    disabled: boolOf(item["disabled"]),
    config: isRecord(config) ? config : {},
    state: rowStateOf(item["state"]),
  }
}

export const parseRows = (value: unknown): readonly PluginRow[] =>
  records(value).flatMap((item) => {
    const row = parseRow(item)
    return row === undefined ? [] : [row]
  })

export const parseCatalog = (value: unknown): readonly CatalogEntry[] =>
  records(value).flatMap((item) => {
    const name = strOf(item["name"])
    if (name === undefined) return []
    return [
      {
        name,
        title: strOf(item["title"]) ?? name,
        description: strOf(item["description"]) ?? "",
        required: boolOf(item["required"]),
        source: strOf(item["source"]) ?? "",
        schema: item["schema"],
      },
    ]
  })

function sourceOf(value: unknown): BundleSource {
  if (!isRecord(value)) return { kind: "local" }
  const version = strOf(value["version"])
  return value["kind"] === "registry" && version !== undefined ? { kind: "registry", version } : { kind: "local" }
}

function parseBundle(item: Readonly<Record<string, unknown>>): BundleView | undefined {
  const name = strOf(item["package"])
  if (name === undefined) return undefined
  return {
    package: name,
    source: sourceOf(item["source"]),
    requires: stringList(item["requires"]),
    rows: records(item["rows"]).flatMap((row) => {
      const id = strOf(row["id"])
      return id === undefined ? [] : [{ id, state: rowStateOf(row["state"]) }]
    }),
    patch: records(item["patch"]).flatMap((row) => {
      const id = strOf(row["id"])
      return id === undefined ? [] : [id]
    }),
  }
}

export const parsePackages = (value: unknown): Packages => {
  const root: Readonly<Record<string, unknown>> = isRecord(value) ? value : {}
  const pending: Readonly<Record<string, unknown>> = isRecord(root["pending"]) ? root["pending"] : {}
  return {
    installed: records(root["installed"]).flatMap((item) => {
      const name = strOf(item["package"])
      if (name === undefined) return []
      return [{ package: name, version: strOf(item["version"]) ?? "dev" }]
    }),
    pending: {
      add: stringList(pending["add"]),
      remove: stringList(pending["remove"]),
    },
    bundles: records(root["bundles"]).flatMap((item) => {
      const bundle = parseBundle(item)
      return bundle === undefined ? [] : [bundle]
    }),
  }
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const list: readonly unknown[] = value
  return list.flatMap((entry) => strOf(entry) ?? [])
}

function marketStatusOf(value: unknown): MarketStatus {
  switch (value) {
    case "installed":
      return "installed"
    case "update-available":
      return "update-available"
    case "different-version":
      return "different-version"
    case "provided":
      return "provided"
    default:
      return "not-installed"
  }
}

function parseSummary(item: Readonly<Record<string, unknown>>): MarketSummary | undefined {
  const name = strOf(item["name"])
  if (name === undefined) return undefined
  return {
    name,
    title: localized(item["title"]) ?? name,
    description: localized(item["description"]) ?? "",
    author: strOf(item["author"]),
    category: strOf(item["category"]),
    homepage: strOf(item["homepage"]),
    repository: repositoryOf(item["repository"]),
    status: marketStatusOf(item["status"]),
    skipped: item["skipped"] === true,
  }
}

function repositoryOf(value: unknown): string | undefined {
  if (isRecord(value)) return strOf(value["url"])
  return strOf(value)
}

export const parseMarket = (value: unknown): readonly MarketSummary[] => {
  const root: Readonly<Record<string, unknown>> = isRecord(value) ? value : {}
  return records(root["entries"]).flatMap((item) => {
    const summary = parseSummary(item)
    return summary === undefined ? [] : [summary]
  })
}

export const parseMarketDetail = (value: unknown): MarketDetail | undefined => {
  if (!isRecord(value)) return undefined
  const name = strOf(value["name"])
  if (name === undefined) return undefined
  const kindValue = value["kind"]
  const kind = kindValue === "bundle" || kindValue === "code" ? kindValue : undefined
  return {
    name,
    kind,
    status: marketStatusOf(value["status"]),
    versions: records(value["versions"]).flatMap((item) => {
      const version = strOf(item["version"])
      if (version === undefined) return []
      return [
        {
          version,
          publishTimestamp: numOf(item["publishTimestamp"]),
          compatible: boolOf(item["compatible"]),
          skipped: item["skipped"] === true,
        },
      ]
    }),
    readme: strOf(value["readme"]),
    requires: stringList(value["requires"]),
    rows: records(value["rows"]).flatMap((item) => {
      const id = strOf(item["id"])
      const plugin = strOf(item["plugin"])
      if (id === undefined || plugin === undefined) return []
      return [{ id, plugin, config: item["config"], disabled: boolOf(item["disabled"]) }]
    }),
  }
}

export const parseInstall = (value: unknown): InstallResult => {
  const root: Readonly<Record<string, unknown>> = isRecord(value) ? value : {}
  const raw = root["application"]
  const application = raw === "applied" || raw === "pending" || raw === "failed" ? raw : "failed"
  return {
    application,
    package: strOf(root["package"]) ?? "",
    version: strOf(root["version"]),
    kind: strOf(root["kind"]),
    rows: records(root["rows"]).flatMap((item) => {
      const id = strOf(item["id"])
      if (id === undefined) return []
      return [{ id, error: strOf(item["error"]) }]
    }),
  }
}

export const parseSkills = (value: unknown): readonly SkillRow[] =>
  records(value).flatMap((item) => {
    const name = strOf(item["name"])
    if (name === undefined) return []
    return [{ name, description: strOf(item["description"]) ?? "" }]
  })

export type PresetSelection = { readonly conversation: number; readonly preset: string }

export type PresetList = {
  readonly presets: readonly PresetRow[]
  readonly default: string | undefined
  readonly conversations: readonly PresetSelection[]
}

export const parsePresets = (value: unknown): PresetList => {
  const root: Readonly<Record<string, unknown>> = isRecord(value) ? value : {}
  const fallback = strOf(root["default"])
  const presets = records(root["presets"]).flatMap((item): readonly PresetRow[] => {
    const id = strOf(item["id"])
    if (id === undefined) return []
    const plugins = item["plugins"]
    return [
      {
        id,
        name: strOf(item["name"]) ?? id,
        description: strOf(item["description"]),
        plugins: plugins === "all" ? "all" : stringList(plugins),
        isDefault: fallback === undefined ? false : fallback === id,
      },
    ]
  })
  const conversations = records(root["conversations"]).flatMap((item) => {
    const conversation = numOf(item["conversation"])
    const preset = strOf(item["preset"])
    return conversation === undefined || preset === undefined ? [] : [{ conversation, preset }]
  })
  return { presets, default: fallback, conversations }
}

export const parseServers = (value: unknown): readonly McpServer[] =>
  records(value).flatMap((item) => {
    const name = strOf(item["name"])
    if (name === undefined) return []
    return [
      {
        name,
        url: strOf(item["url"]) ?? "",
        tools: numOf(item["tools"]) ?? 0,
        error: strOf(item["error"]),
        source: strOf(item["source"]),
      },
    ]
  })


export const rows = remote(() => cmd("plugin.list"), parseRows)
export const catalog = remote(() => cmd("plugin.catalog"), parseCatalog)
export const packages = remote(() => cmd("plugin.packages"), parsePackages)
export const market = remote(() => cmd("market.search", {}), parseMarket)
export const skills = remote(() => cmd("skill.list"), parseSkills)
export const presets = remote(() => cmd("preset.list"), parsePresets)
export const servers = remote(() => cmd("mcp.list"), parseServers)

const details = new Map<string, RemoteHandle<MarketDetail | undefined>>()

export function marketDetail(name: string): RemoteHandle<MarketDetail | undefined> {
  const existing = details.get(name)
  if (existing !== undefined) return existing
  const created = remote(() => cmd("market.entry", { name }), parseMarketDetail)
  details.set(name, created)
  return created
}


interface ParsedVersion {
  readonly numbers: readonly number[]
  readonly prerelease: boolean
}

function parsedVersion(text: string): ParsedVersion {
  const [core = "", ...tail] = text.split("-")
  const numbers = core.split(".").map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
  return { numbers, prerelease: tail.length > 0 }
}

export function compareVersions(left: string, right: string): number {
  const a = parsedVersion(left)
  const b = parsedVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1
  return 0
}

export function offeredVersion(detail: MarketDetail | undefined): MarketVersion | undefined {
  if (detail === undefined || detail.versions.length === 0) return undefined
  const compatible = detail.versions.filter((version) => version.compatible)
  const pool = compatible.length > 0 ? compatible : detail.versions
  return [...pool].sort((left, right) => compareVersions(right.version, left.version))[0]
}


export async function setRowEnabled(id: string, enabled: boolean): Promise<void> {
  await cmd("plugin.enable", { id, enabled })
  await Promise.all([rows.reload(), packages.reload()])
}

export async function configureRow(id: string, config: Readonly<Record<string, unknown>>): Promise<void> {
  await cmd("plugin.configure", { id, config })
  await Promise.all([rows.reload(), packages.reload()])
}

export async function installFromMarket(name: string): Promise<InstallResult> {
  const result = parseInstall(await cmd("market.install", { name }))
  await Promise.all([rows.reload(), packages.reload(), market.reload(), marketDetail(name).reload()])
  return result
}

export async function updateFromMarket(name: string, version: string): Promise<InstallResult> {
  const result = parseInstall(await cmd("market.update", { name, version }))
  await Promise.all([rows.reload(), packages.reload(), market.reload(), marketDetail(name).reload()])
  return result
}

export type RefreshResult = {
  readonly indexes: readonly { readonly url: string; readonly error?: string | undefined }[]
  readonly applied: readonly { readonly package: string; readonly version: string; readonly application: string }[]
}

export async function refreshMarket(): Promise<RefreshResult> {
  const value = await cmd<unknown>("market.refresh")
  await Promise.all([market.reload(), packages.reload(), rows.reload()])
  if (!isRecord(value)) return { indexes: [], applied: [] }
  return {
    indexes: records(value["indexes"]).flatMap((item) => {
      const url = strOf(item["url"])
      if (url === undefined) return []
      return [{ url, error: strOf(item["error"]) }]
    }),
    applied: records(value["applied"]).flatMap((item) => {
      const packageName = strOf(item["package"])
      const version = strOf(item["version"])
      if (packageName === undefined || version === undefined) return []
      return [{ package: packageName, version, application: strOf(item["application"]) ?? "failed" }]
    }),
  }
}

export type Prompt = { readonly name: string; readonly description?: string | undefined; readonly text: string }

export const parsePrompts = (value: unknown): readonly Prompt[] =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const name = strOf(entry["name"])
    const text = strOf(entry["text"])
    if (name === undefined || text === undefined) return []
    return [{ name, description: strOf(entry["description"]), text }]
  })

export const prompts: RemoteHandle<readonly Prompt[]> = remote(() => cmd("prompt.list"), parsePrompts)

export async function putPrompt(name: string, text: string, description?: string): Promise<void> {
  await cmd("prompt.put", description === undefined ? { name, text } : { name, text, description })
  await prompts.reload()
}

export async function deletePrompt(name: string): Promise<void> {
  await cmd("prompt.delete", { name })
  await prompts.reload()
}

export type SkillBody = { readonly name: string; readonly description: string; readonly markdown: string }

export async function readSkill(name: string): Promise<SkillBody> {
  const value = await cmd<unknown>("skill.read", { name })
  if (!isRecord(value)) throw new Error(`skill.read returned nothing for ${name}`)
  return {
    name: strOf(value["name"]) ?? name,
    description: strOf(value["description"]) ?? "",
    markdown: strOf(value["markdown"]) ?? "",
  }
}

export type McpTool = { readonly name: string; readonly description?: string | undefined }

export async function readMcpTools(name: string): Promise<readonly McpTool[]> {
  const value = await cmd<unknown>("mcp.tools", { name })
  const tools = isRecord(value) && Array.isArray(value["tools"]) ? value["tools"] : []
  return tools.flatMap((tool) => {
    if (!isRecord(tool)) return []
    const toolName = strOf(tool["name"])
    return toolName === undefined ? [] : [{ name: toolName, description: strOf(tool["description"]) }]
  })
}

export async function skipMarketVersion(name: string, version: string | undefined): Promise<void> {
  await cmd("market.skip", version === undefined ? { name } : { name, version })
  await Promise.all([market.reload(), marketDetail(name).reload()])
}

export async function unskipMarketVersion(name: string): Promise<void> {
  await cmd("market.unskip", { name })
  await Promise.all([market.reload(), marketDetail(name).reload(), skippedMarket.reload()])
}

export type SkippedVersion = { readonly name: string; readonly version: string | undefined }

export const skippedMarket: RemoteHandle<readonly SkippedVersion[]> = remote(
  () => cmd("market.skipped"),
  (value) =>
    records(value).flatMap((item) => {
      const name = strOf(item["name"])
      return name === undefined ? [] : [{ name, version: strOf(item["version"]) }]
    }),
)

export type RollbackResult = { readonly application: string; readonly reason?: string | undefined }

export async function rollbackPackage(name: string): Promise<RollbackResult> {
  const value = await cmd<unknown>("market.rollback", { name })
  await Promise.all([rows.reload(), packages.reload(), market.reload()])
  if (!isRecord(value)) return { application: "failed" }
  return { application: strOf(value["application"]) ?? "failed", reason: strOf(value["reason"]) }
}

export type MarketPolicy = { readonly autoUpdate: boolean }

export const marketPolicy: RemoteHandle<MarketPolicy> = remote(() => cmd("market.policy"), (value) => ({
  autoUpdate: isRecord(value) && value["autoUpdate"] === true,
}))

export async function setMarketPolicy(autoUpdate: boolean): Promise<void> {
  await cmd("market.policy.set", { autoUpdate })
  await marketPolicy.reload()
}

export async function installSpec(spec: string): Promise<void> {
  await cmd("plugin.install", { spec })
  await packages.reload()
}

export async function uninstallPackage(name: string): Promise<void> {
  await cmd("plugin.uninstall", { package: name })
  await Promise.all([rows.reload(), packages.reload()])
}

export async function addServer(name: string, url: string, headers: Readonly<Record<string, string>> | undefined): Promise<void> {
  await cmd("mcp.add", headers === undefined ? { name, url } : { name, url, headers })
  await servers.reload()
}

export async function removeServer(name: string): Promise<void> {
  await cmd("mcp.remove", { name })
  await servers.reload()
}

export async function putSkill(markdown: string): Promise<void> {
  const name = frontmatterName(markdown)
  await cmd("skill.put", { name, markdown })
  await skills.reload()
}

export async function removeSkill(name: string): Promise<void> {
  await cmd("skill.delete", { name })
  await skills.reload()
}

export function frontmatterName(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown.trimStart())
  if (match === null) return ""
  const name = /^name:\s*(.+)$/mu.exec(match[1] ?? "")
  return name?.[1]?.trim() ?? ""
}

export function isKnownOpError(error: unknown): boolean {
  return error instanceof OpError && error.code === "unknown_op"
}
