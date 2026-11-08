import { cmd } from "../lib/api.ts"
import { errorMessage, isKnownOpError, isRecord, remote, type RemoteHandle } from "./extensions.ts"


export type ModelRole = "chat" | "thread" | "utility"

export type ModelPrice = { readonly input: number; readonly output: number }

export type ModelInfo = {
  readonly provider: string
  readonly modelId: string
  readonly name: string
  readonly contextWindow: number
  readonly vision: boolean
  readonly reasoning: boolean
  readonly keyed: boolean
  readonly cost: ModelPrice | undefined
}

/** V3: one mark per price band, from the catalog's own rate per million tokens, blended across input and output. */
export function priceMarks(price: ModelPrice | undefined): string {
  if (price === undefined) return ""
  const perMillion = (price.input + price.output) / 2
  if (perMillion <= 0) return ""
  if (perMillion < 2) return "$"
  return perMillion < 10 ? "$$" : "$$$"
}

export type ModelRef = { readonly provider: string; readonly modelId: string }

export type ModelsList = { readonly models: readonly ModelInfo[]; readonly omitted: number }

export type ProviderSummary = {
  readonly id: string
  readonly models: readonly ModelInfo[]
}

const MODEL_ROLES: readonly ModelRole[] = ["chat", "thread", "utility"]

export const ROLE_LABEL: Readonly<Record<ModelRole, string>> = {
  chat: "Coordinator",
  thread: "Threads",
  utility: "Titles + summaries",
}

export const roles = MODEL_ROLES

const priceOf = (value: unknown): ModelPrice | undefined => {
  if (!isRecord(value)) return undefined
  const input = value["input"]
  const output = value["output"]
  if (typeof input !== "number" || typeof output !== "number") return undefined
  return { input, output }
}

export const parseModels = (value: unknown): ModelsList => {
  const root: Readonly<Record<string, unknown>> = isRecord(value) ? value : {}
  const listed: readonly unknown[] = Array.isArray(root["models"]) ? root["models"] : []
  return {
    models: listed.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const providerValue = entry["provider"]
      const modelIdValue = entry["modelId"]
      const provider = typeof providerValue === "string" ? providerValue : undefined
      const modelId = typeof modelIdValue === "string" ? modelIdValue : undefined
      if (provider === undefined || modelId === undefined) return []
      const name = entry["name"]
      const contextWindow = entry["contextWindow"]
      return [
        {
          provider,
          modelId,
          name: typeof name === "string" ? name : modelId,
          contextWindow: typeof contextWindow === "number" ? contextWindow : 0,
          vision: entry["vision"] === true,
          reasoning: entry["reasoning"] === true,
          keyed: entry["keyed"] !== false,
          cost: priceOf(entry["cost"]),
        },
      ]
    }),
    omitted: typeof root["omittedModels"] === "number" ? root["omittedModels"] : 0,
  }
}

export const models: RemoteHandle<ModelsList> = remote(() => cmd("models.list"), parseModels)

/** The composer's picker: the catalog with unkeyed models included; the server filters and ranks a non-empty query. */
export async function searchModels(query: string): Promise<ModelsList> {
  const trimmed = query.trim()
  const args = trimmed === "" ? { includeUnkeyed: true } : { includeUnkeyed: true, query: trimmed }
  return parseModels(await cmd<unknown>("models.list", args))
}

/** The catalog's own name for a model, so no surface shows a raw id when the catalog knows it. */
export function modelName(provider: string | undefined, modelId: string | undefined): string | undefined {
  const state = models.state()
  if (state.kind !== "ready" || modelId === undefined) return undefined
  const found = state.value.models.find(
    (model) => model.modelId === modelId && (provider === undefined || model.provider === provider),
  )
  return found?.name
}

export function providers(value: ModelsList): readonly ProviderSummary[] {
  const grouped = new Map<string, ModelInfo[]>()
  for (const model of value.models) {
    const found = grouped.get(model.provider)
    if (found === undefined) grouped.set(model.provider, [model])
    else found.push(model)
  }
  return [...grouped.entries()]
    .map(([id, list]) => ({ id, models: list }))
    .sort((left, right) => left.id.localeCompare(right.id))
}


export type UsageBucket = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly cost: number
}

export type UsageDay = {
  readonly day: string
  readonly spend: number
  readonly tokens: number
}

export type ModelUsage = UsageBucket & {
  readonly name: string
  readonly provider: string
  readonly modelId: string
}

export type ToolUsage = UsageBucket & { readonly name: string }

export type UsageSummary =
  | { readonly recorded: false }
  | {
      readonly recorded: true
      readonly spend: number
      readonly tokens: number
      readonly today: number
      readonly month: number
      readonly days: readonly UsageDay[]
      readonly cap: number | null
      readonly alert: number
      readonly byModel: readonly ModelUsage[]
      readonly byTool: readonly ToolUsage[]
      readonly byProject: readonly ProjectSpend[]
    }

export type ProjectSpend = {
  readonly id: string
  readonly name: string
  readonly spend: number
  readonly tokens: number
}

function numberFrom(record: Readonly<Record<string, unknown>>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function bucketOf(entry: unknown): UsageBucket {
  const record: Readonly<Record<string, unknown>> = isRecord(entry) ? entry : {}
  return {
    input: numberFrom(record, ["input"]) ?? 0,
    output: numberFrom(record, ["output"]) ?? 0,
    cacheRead: numberFrom(record, ["cacheRead"]) ?? 0,
    cacheWrite: numberFrom(record, ["cacheWrite"]) ?? 0,
    totalTokens: numberFrom(record, ["totalTokens", "tokens"]) ?? 0,
    cost: numberFrom(record, ["cost", "spend"]) ?? 0,
  }
}

export const parseUsage = (value: unknown): UsageSummary => {
  if (!isRecord(value)) return { recorded: false }
  const spend = numberFrom(value, ["spend"])
  if (spend === undefined) return { recorded: false }
  const models: readonly unknown[] = Array.isArray(value["byModel"]) ? value["byModel"] : []
  const tools: readonly unknown[] = Array.isArray(value["byTool"]) ? value["byTool"] : []
  const projects: readonly unknown[] = Array.isArray(value["byProject"]) ? value["byProject"] : []
  const cap = value["cap"]
  return {
    recorded: true,
    spend,
    tokens: numberFrom(value, ["tokens", "totalTokens"]) ?? 0,
    today: bucketOf(value["today"]).cost,
    month: bucketOf(value["month"]).cost,
    cap: typeof cap === "number" && Number.isFinite(cap) ? cap : null,
    alert: numberFrom(value, ["alert"]) ?? 0,
    byProject: projects.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const id = entry["id"]
      const name = entry["name"]
      if (typeof id !== "string" || typeof name !== "string") return []
      return [{ id, name, spend: bucketOf(entry).cost, tokens: bucketOf(entry).totalTokens }]
    }),
    days: (Array.isArray(value["days"]) ? value["days"] : []).flatMap((row) => {
      if (!isRecord(row)) return []
      const day = row["day"]
      if (typeof day !== "string") return []
      return [{ day, spend: bucketOf(row).cost, tokens: bucketOf(row).totalTokens }]
    }),
    byModel: models.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const name = entry["name"]
      if (typeof name !== "string") return []
      const provider = entry["provider"]
      const modelId = entry["modelId"]
      return [
        {
          ...bucketOf(entry),
          name,
          provider: typeof provider === "string" ? provider : "",
          modelId: typeof modelId === "string" ? modelId : "",
        },
      ]
    }),
    byTool: tools.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const name = entry["name"]
      if (typeof name !== "string") return []
      return [{ ...bucketOf(entry), name }]
    }),
  }
}

export const usage: RemoteHandle<UsageSummary> = remote(async () => {
  try {
    return await cmd("usage.summary")
  } catch (error: unknown) {
    if (isKnownOpError(error)) return { recorded: false }
    throw error
  }
}, parseUsage)

export async function setUsageCap(usd: number | null): Promise<void> {
  await cmd("usage.cap.set", usd === null ? { clear: true } : { usd })
  await usage.reload()
}

export async function setUsageAlert(usd: number): Promise<void> {
  await cmd("usage.alert.set", { usd })
  await usage.reload()
}


export type SystemVersion = {
  readonly build: string
  readonly bundles: readonly string[]
  readonly degraded: boolean
  readonly rows: readonly { readonly id: string; readonly state: string }[]
}

export const parseSystemVersion = (value: unknown): SystemVersion => {
  const root: Readonly<Record<string, unknown>> = isRecord(value) ? value : {}
  const rowList: readonly unknown[] = Array.isArray(root["rows"]) ? root["rows"] : []
  const bundleList: readonly unknown[] = Array.isArray(root["bundles"]) ? root["bundles"] : []
  return {
    build: typeof root["build"] === "string" ? root["build"] : "dev",
    bundles: bundleList.flatMap((entry) => (typeof entry === "string" ? [entry] : [])),
    degraded: root["degraded"] === true,
    rows: rowList.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const id = entry["id"]
      if (typeof id !== "string") return []
      const state = entry["state"]
      return [{ id, state: typeof state === "string" ? state : "pending" }]
    }),
  }
}

export const systemVersion: RemoteHandle<SystemVersion> = remote(() => cmd("system.version"), parseSystemVersion)

export type UpdateOutcome = { readonly application: "deploying" | "failed"; readonly detail: string }

export async function systemUpdate(): Promise<UpdateOutcome> {
  const value = await cmd<unknown>("system.update")
  const root: Readonly<Record<string, unknown>> = isRecord(value) ? value : {}
  return {
    application: root["application"] === "deploying" ? "deploying" : "failed",
    detail: typeof root["detail"] === "string" ? root["detail"] : "",
  }
}

export async function systemRestart(hard: boolean): Promise<void> {
  await cmd("system.restart", { hard })
  await systemVersion.reload()
}

export type SystemMetrics = {
  readonly uptimeMs: number
  readonly storageBytes: number
  readonly sockets: number
  readonly rows: { readonly total: number; readonly active: number }
  readonly pushDevices: number
}

export const parseSystemMetrics = (value: unknown): SystemMetrics => {
  const root = isRecord(value) ? value : {}
  const rows = isRecord(root["rows"]) ? root["rows"] : {}
  const count = (candidate: unknown): number => (typeof candidate === "number" ? candidate : 0)
  return {
    uptimeMs: count(root["uptimeMs"]),
    storageBytes: count(root["storageBytes"]),
    sockets: count(root["sockets"]),
    rows: { total: count(rows["total"]), active: count(rows["active"]) },
    pushDevices: count(root["pushDevices"]),
  }
}

export const systemMetrics: RemoteHandle<SystemMetrics> = remote(() => cmd("system.metrics"), parseSystemMetrics)

export type LogEntry = { readonly at: number; readonly level: "warn" | "error"; readonly text: string }

/** The warnings and errors this home logged since it woke, newest last. */
export async function systemLogs(): Promise<readonly LogEntry[]> {
  const value = await cmd<unknown>("system.logs")
  const entries = isRecord(value) && Array.isArray(value["entries"]) ? value["entries"] : []
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const at = entry["at"]
    const level = entry["level"]
    const text = entry["text"]
    if (typeof at !== "number" || typeof text !== "string") return []
    return [{ at, level: level === "error" ? "error" : "warn", text }]
  })
}

export type Session = { readonly id: string; readonly since: number; readonly origin: string }

export const parseSessions = (value: unknown): readonly Session[] =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const id = entry["id"]
    const since = entry["since"]
    const origin = entry["origin"]
    if (typeof id !== "string" || id === "") return []
    return [{ id, since: typeof since === "number" ? since : 0, origin: typeof origin === "string" ? origin : "" }]
  })

export const sessions: RemoteHandle<readonly Session[]> = remote(() => cmd("session.list"), parseSessions)

/** Closes one live socket, or all of them when no id is given; returns how many closed. */
export async function closeSessions(id?: string): Promise<number> {
  const value = await cmd<unknown>("session.close", id === undefined ? {} : { id })
  await sessions.reload()
  return isRecord(value) && typeof value["closed"] === "number" ? value["closed"] : 0
}

/** Mints a new owner token and closes every socket; the token is readable once, so the caller stores it. */
export async function rotateSession(): Promise<string> {
  const value = await cmd<unknown>("session.rotate")
  const token = isRecord(value) && typeof value["token"] === "string" ? value["token"] : ""
  if (token === "") throw new Error("session.rotate answered no token")
  await sessions.reload()
  return token
}


export async function setDefault(role: ModelRole, model: ModelRef): Promise<void> {
  await cmd("owner.defaults", { role, model })
}

export async function saveCredential(provider: string, key: string, custom?: { baseUrl: string; api: string }): Promise<void> {
  const args: Record<string, unknown> = { provider }
  if (key !== "") args["key"] = key
  if (custom !== undefined) args["custom"] = { baseUrl: custom.baseUrl, key, api: custom.api }
  await cmd("credential.set", args)
  await models.reload()
}

export async function deleteCredential(provider: string): Promise<void> {
  await cmd("credential.delete", { provider })
  await models.reload()
}


export type NotifyKind = "waiting" | "finished" | "failed" | "spend" | "schedule"

export type NotifyPrefs = Readonly<Record<NotifyKind, boolean>>

export const parseNotifyPrefs = (value: unknown): NotifyPrefs => {
  const root = isRecord(value) ? value : {}
  return {
    waiting: root["waiting"] !== false,
    finished: root["finished"] !== false,
    failed: root["failed"] !== false,
    spend: root["spend"] !== false,
    schedule: root["schedule"] === true,
  }
}

export const notifyPrefs: RemoteHandle<NotifyPrefs> = remote(() => cmd("notify.prefs"), parseNotifyPrefs)

export const DEFAULT_NOTIFY: NotifyPrefs = { waiting: true, finished: true, failed: true, spend: true, schedule: false }

/** The prefs a switch shows: the server's once they arrive, all on until then. */
export function notifyNow(): NotifyPrefs {
  const state = notifyPrefs.state()
  return state.kind === "ready" ? state.value : DEFAULT_NOTIFY
}

export async function setNotifyPrefs(patch: Partial<NotifyPrefs>): Promise<void> {
  await cmd("notify.set", patch)
  await notifyPrefs.reload()
}

export type PushSubscriptionKeys = { readonly p256dh: string; readonly auth: string }

export type OwnerSettings = { readonly name: string; readonly instructions: string }

export const parseOwner = (value: unknown): OwnerSettings => {
  const root = isRecord(value) ? value : {}
  return {
    name: typeof root["name"] === "string" ? root["name"] : "",
    instructions: typeof root["instructions"] === "string" ? root["instructions"] : "",
  }
}

export const owner: RemoteHandle<OwnerSettings> = remote(() => cmd("owner.read"), parseOwner)

export async function setOwner(patch: { name?: string; instructions?: string }): Promise<OwnerSettings> {
  const next = parseOwner(await cmd("owner.set", patch))
  await owner.reload()
  return next
}

/** The owner's name, or "Owner" until one is stored. */
export function ownerName(): string {
  const state = owner.state()
  if (state.kind !== "ready" || state.value.name.trim() === "") return "Owner"
  return state.value.name
}

export type QuietHours = { readonly enabled: boolean; readonly start: number; readonly end: number }

export const DEFAULT_QUIET: QuietHours = { enabled: false, start: 1320, end: 420 }

export const parseQuiet = (value: unknown): QuietHours => {
  const root = isRecord(value) ? value : {}
  const start = root["start"]
  const end = root["end"]
  return {
    enabled: root["enabled"] === true,
    start: typeof start === "number" ? start : DEFAULT_QUIET.start,
    end: typeof end === "number" ? end : DEFAULT_QUIET.end,
  }
}

export const quietHours: RemoteHandle<QuietHours> = remote(() => cmd("notify.quiet"), parseQuiet)

export async function setQuietHours(patch: Partial<QuietHours>): Promise<void> {
  await cmd("notify.quiet.set", patch)
  await quietHours.reload()
}

export type PushDevice = { readonly endpoint: string; readonly origin: string }

export const parsePushDevices = (value: unknown): readonly PushDevice[] =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const endpoint = entry["endpoint"]
    const origin = entry["origin"]
    return typeof endpoint === "string" && typeof origin === "string" ? [{ endpoint, origin }] : []
  })

export const pushDevices: RemoteHandle<readonly PushDevice[]> = remote(() => cmd("push.list"), parsePushDevices)

export async function removePushDevice(endpoint: string): Promise<void> {
  await cmd("push.unsubscribe", { endpoint })
  await pushDevices.reload()
}

/** Deliver one notification to every subscribed browser; the count comes back from the Worker. */
export async function pushTest(): Promise<number> {
  const value = await cmd<unknown>("push.test")
  return isRecord(value) && typeof value["sent"] === "number" ? value["sent"] : 0
}

export async function pushKey(): Promise<string> {
  const value = await cmd<unknown>("push.key")
  if (!isRecord(value) || typeof value["applicationServerKey"] !== "string")
    throw new Error("push.key returned no application server key")
  return value["applicationServerKey"]
}

export async function pushSubscribe(endpoint: string, keys: PushSubscriptionKeys): Promise<void> {
  await cmd("push.subscribe", { endpoint, keys })
}

export async function pushUnsubscribe(endpoint: string): Promise<void> {
  await cmd("push.unsubscribe", { endpoint })
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.replace(/-/gu, "+").replace(/_/gu, "/")
  const full = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")
  const binary = atob(full)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export type BrowserSubscription = { readonly endpoint: string; readonly keys: PushSubscriptionKeys }

export function subscriptionOf(subscription: PushSubscription): BrowserSubscription | undefined {
  const json = subscription.toJSON()
  const endpoint = json.endpoint
  const keys = json.keys
  if (endpoint === undefined || keys === undefined) return undefined
  const p256dh = keys["p256dh"]
  const auth = keys["auth"]
  if (p256dh === undefined || auth === undefined) return undefined
  return { endpoint, keys: { p256dh, auth } }
}

export { errorMessage }
