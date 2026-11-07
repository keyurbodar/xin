import { cmd } from "../lib/api.ts"
import { errorMessage, isKnownOpError, isRecord, remote, type RemoteHandle } from "./extensions.ts"


export type ModelRole = "chat" | "thread" | "utility"

export type ModelInfo = {
  readonly provider: string
  readonly modelId: string
  readonly name: string
  readonly contextWindow: number
  readonly vision: boolean
  readonly reasoning: boolean
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
        },
      ]
    }),
    omitted: typeof root["omittedModels"] === "number" ? root["omittedModels"] : 0,
  }
}

export const models: RemoteHandle<ModelsList> = remote(() => cmd("models.list"), parseModels)

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
      readonly byModel: readonly ModelUsage[]
      readonly byTool: readonly ToolUsage[]
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
  return {
    recorded: true,
    spend,
    tokens: numberFrom(value, ["tokens", "totalTokens"]) ?? 0,
    today: bucketOf(value["today"]).cost,
    month: bucketOf(value["month"]).cost,
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


export type NotifyKind = "waiting" | "finished" | "failed"

export type NotifyPrefs = Readonly<Record<NotifyKind, boolean>>

export const parseNotifyPrefs = (value: unknown): NotifyPrefs => {
  const root = isRecord(value) ? value : {}
  return { waiting: root["waiting"] !== false, finished: root["finished"] !== false, failed: root["failed"] !== false }
}

export const notifyPrefs: RemoteHandle<NotifyPrefs> = remote(() => cmd("notify.prefs"), parseNotifyPrefs)

export const DEFAULT_NOTIFY: NotifyPrefs = { waiting: true, finished: true, failed: true }

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
