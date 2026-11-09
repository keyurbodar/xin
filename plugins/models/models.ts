import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite"
import {
  createModels,
  createProvider,
  type Api,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type MutableModels,
  type Provider as PiProvider,
  type ProviderStreams,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import {
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type AgentChange,
  type ConversationId,
  type Harness,
  type ModelRef,
  type UsageState,
} from "@earendil-works/pi-durable"
import { arr, bool, compile, int, lit, map, num, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema"
import {
  ModelRefSchema,
  ThinkingSchema,
  type ModelDefaults,
  type ModelMatch,
  type ModelsService,
} from "../../src/contracts/models.ts"
import type { Notification } from "../../src/contracts/push.ts"
import { projectInScope, ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { parseWorkspace, WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { CommandId } from "../../src/ids.ts"
import type { Provider } from "../../src/module.ts"
import { defineOp, type Actor, type Command, type Op, OpRejected, type Outcome } from "../../src/ops.ts"
import { Sealer, SealedSchema } from "../../src/seal.ts"

const MAX_LISTED = 40
const MAX_RECENT = 8

type UsageBucket = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly cost: number
}

const EMPTY_USAGE: UsageBucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }

const bucketOf = (usage: UsageState["models"][string]): UsageBucket => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  totalTokens: usage.totalTokens,
  cost: usage.cost.total,
})

const USAGE_TOTAL = "usage.total"
const USAGE_CAP = "usage.cap"
const USAGE_ALERT = "usage.alerted"
const USAGE_ALERT_DAY = "usage.alerted.day"
const USAGE_ALERT_USD = "usage.alert"
const DEFAULT_DAILY_ALERT = 8
const ALERT_SHARE = 0.8

type Total = { readonly spend: number; readonly tokens: number }

type Alert = { readonly month: string; readonly level: number }

export type Spend = { readonly month: number; readonly cap: number | null }

export type ProjectSpend = {
  readonly id: string
  readonly name: string
  readonly spend: number
  readonly tokens: number
}

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)

const monthOf = (now: number): string => dayOf(now).slice(0, 7)
function usageRecorder(db: SqliteDatabase, harness: Harness): () => Promise<UsageState> {
  let queue: Promise<UsageState> = Promise.resolve({ models: {}, tools: {} })
  return () => {
    const run = queue.then(async () => {
      const ledger = await harness.usage(BACKGROUND_CONTEXT)
      const now = ledgerTotal(ledger)
      await db.transaction(async (tx) => {
        const stored = await storedTotal(tx)
        if (stored !== undefined) {
          const spend = now.spend - stored.spend
          const tokens = now.tokens - stored.tokens
          if (spend > 0 || tokens > 0)
            await tx.run(
              "INSERT INTO usage_daily (day, spend, tokens) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET spend = spend + excluded.spend, tokens = tokens + excluded.tokens",
              dayOf(Date.now()),
              spend,
              tokens,
            )
        }
        await watermark(tx, now)
      })
      return ledger
    })
    queue = run.catch(() => ({ models: {}, tools: {} }))
    return run
  }
}

function watermark(db: SqliteExecutor, total: Total): Promise<void> {
  return db.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    USAGE_TOTAL,
    JSON.stringify(total),
  )
}

/** A home that has never written the watermark gets one at boot, so the next flush has a baseline to measure against. */
async function seedUsage(db: SqliteDatabase, harness: Harness): Promise<void> {
  if ((await storedTotal(db)) !== undefined) return
  await watermark(db, ledgerTotal(await harness.usage(BACKGROUND_CONTEXT)))
}

function ledgerTotal(ledger: UsageState): Total {
  const buckets = [...Object.values(ledger.models), ...Object.values(ledger.tools)].map(bucketOf)
  const total = buckets.reduce(addUsage, EMPTY_USAGE)
  return { spend: total.cost, tokens: total.totalTokens }
}
async function storedTotal(db: SqliteExecutor): Promise<Total | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", USAGE_TOTAL)
  if (row === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.spend !== "number" || typeof record.tokens !== "number") return undefined
    return { spend: record.spend, tokens: record.tokens }
  } catch {
    return undefined
  }
}

type Day = Total & { readonly day: string }

async function datedUsage(db: SqliteExecutor): Promise<{ today: Total; month: Total; days: Day[] }> {
  const today = dayOf(Date.now())
  const rows = await db.all<{ day: string; spend: number; tokens: number }>(
    "SELECT day, spend, tokens FROM usage_daily WHERE day >= ? ORDER BY day",
    monthBefore(today),
  )
  const empty: Total = { spend: 0, tokens: 0 }
  const current = rows.filter((row) => row.day >= `${today.slice(0, 7)}-01`)
  const month = current.reduce((sum, row) => ({ spend: sum.spend + row.spend, tokens: sum.tokens + row.tokens }), empty)
  return { today: rows.find((row) => row.day === today) ?? empty, month, days: rows }
}

/** The first day of the month before the one `day` falls in, so the pane can chart this month and the last. */
function monthBefore(day: string): string {
  const [year, month] = day.split("-").map(Number)
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 2, 1)).toISOString().slice(0, 10)
}

async function readCap(db: SqliteExecutor): Promise<number | null> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", USAGE_CAP)
  if (row === undefined) return null
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed !== "object" || parsed === null) return null
    const usd = (parsed as Record<string, unknown>).usd
    return typeof usd === "number" && Number.isFinite(usd) ? usd : null
  } catch {
    return null
  }
}

async function readAlert(db: SqliteExecutor): Promise<Alert | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", USAGE_ALERT)
  if (row === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.month !== "string" || typeof record.level !== "number") return undefined
    return { month: record.month, level: record.level }
  } catch {
    return undefined
  }
}

async function readDayMark(db: SqliteExecutor): Promise<string | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", USAGE_ALERT_DAY)
  if (row === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const day = (parsed as Record<string, unknown>).day
    return typeof day === "string" ? day : undefined
  } catch {
    return undefined
  }
}

async function readDailyAlert(db: SqliteExecutor): Promise<number> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", USAGE_ALERT_USD)
  if (row === undefined) return DEFAULT_DAILY_ALERT
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_DAILY_ALERT
    const usd = (parsed as Record<string, unknown>).usd
    return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : DEFAULT_DAILY_ALERT
  } catch {
    return DEFAULT_DAILY_ALERT
  }
}

const spendNotice = (title: string, body: string): Notification => ({
  threadTitle: "Xin",
  title,
  body,
  tag: "spend",
  kind: "spend",
})

/** One push per threshold: a day past the daily alert, and the month past 80% of the cap and past the cap itself. */
async function alertSpend(
  db: SqliteDatabase,
  notify: ((notification: Notification) => Promise<void>) | undefined,
  alertsOn: () => Promise<boolean>,
): Promise<void> {
  if (notify === undefined || !(await alertsOn())) return
  const [dated, cap, daily] = await Promise.all([datedUsage(db), readCap(db), readDailyAlert(db)])
  const day = dayOf(Date.now())
  const month = monthOf(Date.now())
  const pending: Notification[] = []
  if (daily > 0 && dated.today.spend >= daily && (await readDayMark(db)) !== day) {
    await writeKv(db, USAGE_ALERT_DAY, { day })
    pending.push(
      spendNotice("Passed today's spend alert", `${dated.today.spend.toFixed(2)} of ${daily.toFixed(2)} USD today.`),
    )
  }
  if (cap !== null && cap > 0) {
    const level = dated.month.spend >= cap ? 100 : dated.month.spend >= cap * ALERT_SHARE ? 80 : 0
    const alerted = await readAlert(db)
    if (level > 0 && !(alerted?.month === month && alerted.level >= level)) {
      await writeKv(db, USAGE_ALERT, { month, level })
      pending.push(
        spendNotice(
          level === 100 ? "Monthly cap reached" : "Spend passed 80% of the cap",
          `${dated.month.spend.toFixed(2)} of ${cap.toFixed(2)} USD this month.`,
        ),
      )
    }
  }
  for (const notification of pending)
    await notify(notification).catch((failure: unknown) => console.warn("models: spend alert failed", failure))
}

/** Spend per project, from each coordinator and thread's own `pi.usage` document. */
async function projectSpend(harness: Harness): Promise<ProjectSpend[]> {
  const workspace = await harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT)
  if (workspace === undefined || !parseWorkspace.check(workspace)) return []
  const projects = await Promise.all(
    Object.entries(workspace.projects).map(async ([id, project]) => {
      const conversations: ConversationId[] = [
        project.coordinatorId as ConversationId,
        ...project.threadIds.map((threadId) => threadId as ConversationId),
      ]
      const ledgers = await Promise.all(
        conversations.map((conversation) => harness.snapshot(UsageDoc, conversation, BACKGROUND_CONTEXT)),
      )
      const total = ledgers
        .flatMap((ledger) => (ledger === undefined ? [] : [ledgerTotal(ledger)]))
        .reduce((sum, usage) => ({ spend: sum.spend + usage.spend, tokens: sum.tokens + usage.tokens }), {
          spend: 0,
          tokens: 0,
        })
      return { id, name: project.name, spend: total.spend, tokens: total.tokens }
    }),
  )
  return projects.toSorted((left, right) => right.spend - left.spend || left.name.localeCompare(right.name))
}

const addUsage = (sum: UsageBucket, usage: UsageBucket): UsageBucket => ({
  input: sum.input + usage.input,
  output: sum.output + usage.output,
  cacheRead: sum.cacheRead + usage.cacheRead,
  cacheWrite: sum.cacheWrite + usage.cacheWrite,
  totalTokens: sum.totalTokens + usage.totalTokens,
  cost: sum.cost + usage.cost,
})

const RoleSchema = oneOf(["chat", "thread", "utility"] as const)
const CustomSchema = obj({ baseUrl: str({ minLength: 1 }), key: str({ minLength: 1 }), api: str({ minLength: 1 }) })

const API_STREAMS: Readonly<Record<string, () => ProviderStreams>> = {
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
}

const CredentialSchema = union([
  obj({ type: lit("api_key"), key: opt(str()), env: opt(map(str())) }),
  obj({ type: lit("oauth"), refresh: str(), access: str(), expires: num() }, { open: true }),
])
const EndpointSchema = obj({ baseUrl: str({ minLength: 1 }), api: str({ minLength: 1 }) })
const StoredSchema = obj({ credential: CredentialSchema, endpoint: opt(EndpointSchema) })
const DefaultsSchema = obj({
  chat: opt(ModelRefSchema),
  thread: opt(ModelRefSchema),
  utility: opt(ModelRefSchema),
})
const RefsSchema = arr(ModelRefSchema)
const ListedSchema = obj({ data: opt(arr(unknown())), models: opt(arr(unknown())) }, { open: true })
const ListedModelSchema = obj(
  { id: str({ minLength: 1 }), name: opt(str()), context_length: opt(num()), context_window: opt(num()) },
  { open: true },
)

const storedCheck = compile(StoredSchema)
const sealedCheck = compile(SealedSchema)
const defaultsCheck = compile(DefaultsSchema)
const refsCheck = compile(RefsSchema)
const listedCheck = compile(ListedSchema)
const listedModelCheck = compile(ListedModelSchema)

type Endpoint = { readonly baseUrl: string; readonly api: string }
type StoredEntry = { readonly credential: Credential; readonly endpoint?: Endpoint }
type MutableDefaults = { chat?: ModelRef; thread?: ModelRef; utility?: ModelRef }
type Settings = {
  readonly defaults: ModelDefaults
  readonly favorites: readonly ModelRef[]
  readonly recent: readonly ModelRef[]
}

const label = (providerId: string): string => `credentials:${providerId}`
const same = (left: ModelRef, right: ModelRef): boolean =>
  left.provider === right.provider && left.modelId === right.modelId
const refOf = (model: Model<Api>): ModelRef => ({ provider: model.provider, modelId: model.id })

class SealedCredentialStore implements CredentialStore {
  readonly #chains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly db: SqliteDatabase,
    private readonly sealer: Sealer,
    private readonly changed: () => Promise<void>,
  ) {}

  read(providerId: string): Promise<Credential | undefined> {
    return this.entry(providerId).then((entry) => entry?.credential)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = await this.db.all<{ provider: string }>("SELECT provider FROM credentials ORDER BY provider")
    const infos: CredentialInfo[] = []
    for (const row of rows) {
      const entry = await this.entry(row.provider)
      if (entry !== undefined) infos.push({ providerId: row.provider, type: entry.credential.type })
    }
    return infos
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#serialize(providerId, async () => {
      const current = await this.entry(providerId)
      const next = await fn(current?.credential)
      if (next === undefined) return current?.credential
      const entry: StoredEntry = current === undefined ? { credential: next } : { ...current, credential: next }
      await this.#write(providerId, entry)
      await this.changed()
      return next
    })
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(providerId, async () => {
      await this.db.run("DELETE FROM credentials WHERE provider = ?", providerId)
      await this.changed()
    })
  }

  set(providerId: string, entry: StoredEntry): Promise<void> {
    return this.#serialize(providerId, async () => {
      await this.#write(providerId, entry)
      await this.changed()
    })
  }

  async entry(providerId: string): Promise<StoredEntry | undefined> {
    const row = await this.db.get<{ sealed: string }>("SELECT sealed FROM credentials WHERE provider = ?", providerId)
    if (row === undefined) return undefined
    const sealed: unknown = JSON.parse(row.sealed)
    if (!sealedCheck.check(sealed)) throw new Error(`credential ${providerId} is corrupt`)
    const stored: unknown = JSON.parse(await this.sealer.unseal(sealed, label(providerId)))
    if (!storedCheck.check(stored)) throw new Error(`credential ${providerId} is corrupt`)
    return stored
  }

  #write(providerId: string, entry: StoredEntry): Promise<void> {
    return this.sealer
      .seal(JSON.stringify(entry), label(providerId))
      .then((sealed) =>
        this.db.run(
          "INSERT INTO credentials (provider, sealed) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET sealed = excluded.sealed",
          providerId,
          JSON.stringify(sealed),
        ),
      )
  }

  #serialize<T>(providerId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve()
    const started = previous.catch(() => undefined).then(run)
    const tracked = started.finally(() => {
      if (this.#chains.get(providerId) === tracked) this.#chains.delete(providerId)
    })
    this.#chains.set(providerId, tracked)
    return started
  }
}

type Registry = {
  readonly models: MutableModels
  readonly store: SealedCredentialStore
  readonly custom: ReadonlyMap<string, Endpoint>
  sync(): Promise<void>
  /** Re-register after a credential change; pi-ai caches a provider's auth state until it is set again. */
  restore(provider: string): void
}

export type ModelsPort = {
  readonly db: SqliteDatabase
  readonly harness: Harness
  readonly kek: string
  readonly providers: readonly Provider[]
  run(command: Command, actor: Actor): Promise<Outcome>
  notify?: (notification: Notification) => Promise<void>
  alertsOn?: () => Promise<boolean>
}

export type ModelsParts = {
  readonly service: ModelsService
  readonly ops: readonly Op[]
  models(): Models
  flush(): Promise<UsageState>
  start(): Promise<void>
}

function createRegistry(port: Pick<ModelsPort, "db" | "kek" | "providers">): Registry {
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider] as const))
  const extra = new Map(port.providers.map((provider) => [provider.id, provider] as const))
  const custom = new Map<string, Endpoint>()
  const store = new SealedCredentialStore(port.db, new Sealer(port.kek), sync)
  const models: MutableModels = createModels({ credentials: store })
  for (const provider of [...builtins.values(), ...extra.values()]) models.setProvider(provider)

  /** Re-register a static provider after its credential changes; a custom endpoint is registered by `sync`. */
  function restore(id: string): void {
    const provider = builtins.get(id) ?? extra.get(id)
    if (provider !== undefined) models.setProvider(provider)
    else if (!custom.has(id)) models.deleteProvider(id)
  }

  async function sync(): Promise<void> {
    const rows = await port.db.all<{ provider: string }>("SELECT provider FROM credentials ORDER BY provider")
    const endpoints = new Map<string, Endpoint>()
    for (const row of rows) {
      const entry = await store.entry(row.provider)
      if (entry?.endpoint !== undefined) endpoints.set(row.provider, entry.endpoint)
    }
    for (const id of custom.keys()) {
      if (endpoints.has(id)) continue
      custom.delete(id)
      restore(id)
    }
    for (const [id, endpoint] of endpoints) {
      const previous = custom.get(id)
      const unchanged = previous !== undefined && previous.baseUrl === endpoint.baseUrl && previous.api === endpoint.api
      custom.set(id, endpoint)
      if (unchanged && models.getProvider(id) !== undefined) continue
      if (previous !== undefined) restore(id)
      models.setProvider(endpointProvider(id, endpoint))
    }
    if (endpoints.size > 0) await models.refresh({ providers: [...endpoints.keys()] })
  }

  return { models, store, custom, sync, restore }
}

function endpointProvider(id: string, endpoint: Endpoint): PiProvider {
  const streams = API_STREAMS[endpoint.api]
  if (streams === undefined) throw new Error(`provider ${id} has unsupported api ${endpoint.api}`)
  return createProvider({
    id,
    name: id,
    baseUrl: endpoint.baseUrl,
    auth: {
      apiKey: {
        name: `${id} API key`,
        resolve: async ({ credential }) =>
          credential?.key === undefined
            ? undefined
            : { auth: { apiKey: credential.key, baseUrl: endpoint.baseUrl }, source: "stored credential" },
      },
    },
    models: [],
    fetchModels: (refresh) => discover(id, endpoint, refresh),
    api: { [endpoint.api]: streams() },
  })
}

async function discover(
  provider: string,
  endpoint: Endpoint,
  refresh: RefreshModelsContext,
): Promise<readonly Model<Api>[]> {
  const key = refresh.credential?.type === "api_key" ? refresh.credential.key : undefined
  const base = endpoint.baseUrl.endsWith("/") ? endpoint.baseUrl : `${endpoint.baseUrl}/`
  const reply = await fetch(new URL("models", base), {
    signal: refresh.signal,
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
  })
  if (!reply.ok) throw new Error(`${provider} model list failed with ${reply.status}`)
  const body: unknown = await reply.json()
  if (!listedCheck.check(body)) return []
  const listed = body.data ?? body.models ?? []
  return listed.flatMap((item) => {
    if (!listedModelCheck.check(item)) return []
    const model: Model<Api> = {
      id: item.id,
      name: item.name ?? item.id,
      api: endpoint.api,
      provider,
      baseUrl: endpoint.baseUrl,
      input: ["text"],
      reasoning: false,
      contextWindow: item.context_window ?? item.context_length ?? 128_000,
      maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    return [model]
  })
}

async function readKv<T>(
  db: SqliteDatabase,
  key: string,
  check: (value: unknown) => value is T,
): Promise<T | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)
  if (row === undefined) return undefined
  const value: unknown = JSON.parse(row.value)
  if (!check(value)) throw new Error(`kv ${key} is corrupt`)
  return value
}

async function writeKv(db: SqliteDatabase, key: string, value: JsonValue): Promise<void> {
  await db.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  )
}

async function readSettings(db: SqliteDatabase): Promise<Settings> {
  const defaults = (await readKv(db, "owner.defaults", defaultsCheck.check)) ?? {}
  const favorites = (await readKv(db, "owner.favorites", refsCheck.check)) ?? []
  const recent = (await readKv(db, "owner.recent", refsCheck.check)) ?? []
  return { defaults, favorites, recent }
}

export async function ownerDefaults(db: SqliteDatabase): Promise<ModelDefaults> {
  return (await readSettings(db)).defaults
}

async function credentialSecrets(db: SqliteDatabase, store: SealedCredentialStore): Promise<readonly string[]> {
  const rows = await db.all<{ provider: string }>("SELECT provider FROM credentials ORDER BY provider")
  const found: string[] = []
  for (const row of rows) {
    const entry = await store.entry(row.provider).catch(() => undefined)
    if (entry === undefined) continue
    const credential = entry.credential
    if (credential.type === "api_key") {
      if (credential.key !== undefined) found.push(credential.key)
      found.push(...Object.values(credential.env ?? {}))
    } else {
      found.push(credential.refresh, credential.access)
    }
  }
  return found
}

async function remember(db: SqliteDatabase, model: ModelRef): Promise<void> {
  const settings = await readSettings(db)
  const recent = [model, ...settings.recent.filter((entry) => !same(entry, model))].slice(0, MAX_RECENT)
  await writeKv(db, "owner.recent", recent)
}

async function available(registry: Registry): Promise<readonly Model<Api>[]> {
  const custom = [...registry.custom.keys()]
  if (custom.length > 0) await registry.models.refresh({ providers: custom })
  return registry.models.getAvailable()
}

async function currentModel(harness: Harness, actor: Actor): Promise<ModelRef | undefined> {
  const id = actor.kind === "agent" ? actor.conversationId : ROOT_CONVERSATION_ID
  const conversation = await harness.conversation(id, BACKGROUND_CONTEXT)
  return conversation === undefined ? undefined : (await conversation.agent(BACKGROUND_CONTEXT)).model
}

/**
 * An agent configures itself, or a thread in its own project when it is that project's coordinator.
 * A thread never reaches its coordinator or a sibling.
 */
async function canConfigure(harness: Harness, actor: Actor, target: ConversationId): Promise<boolean> {
  if (actor.kind === "owner") return true
  if (actor.kind !== "agent") return false
  if (actor.conversationId === target) return true
  const own = await harness.snapshot(ThreadDoc, actor.conversationId, BACKGROUND_CONTEXT)
  if (own !== undefined) return false
  const scope = await projectInScope(harness, actor.conversationId)
  return scope !== undefined && scope.project.threadIds.includes(target)
}

function match(model: Model<Api>, query: string): number {
  const target = query.trim().toLowerCase()
  if (target === "") return 0
  const id = model.id.toLowerCase()
  const name = model.name.toLowerCase()
  const provider = model.provider.toLowerCase()
  const text = `${provider} ${id} ${name}`
  const words = target.split(/\s+/)
  if (id === target || name === target || `${provider}/${id}` === target) return 100
  if (id.startsWith(target) || name.startsWith(target)) return 90
  if (id.includes(target) || name.includes(target)) return 80
  if (words.every((word) => text.includes(word))) return 60
  if (words.every((word) => text.includes(word.slice(0, Math.max(1, Math.ceil(word.length / 2)))))) return 40
  return 0
}

function search(catalog: readonly Model<Api>[], query: string): ModelMatch[] {
  return catalog
    .map((model) => ({ model, score: match(model, query) }))
    .filter((hit) => hit.score > 0)
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        left.model.provider.localeCompare(right.model.provider) ||
        left.model.id.localeCompare(right.model.id),
    )
}

function describe(model: Model<Api>, keyed: boolean): JsonValue {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    vision: model.input.includes("image"),
    reasoning: model.reasoning,
    cost: { input: model.cost.input, output: model.cost.output },
    keyed,
  }
}

function ranked(
  catalog: readonly Model<Api>[],
  settings: Settings,
  current: ModelRef | undefined,
  query: string | undefined,
): readonly Model<Api>[] {
  const filtered = query === undefined ? catalog : search(catalog, query).map((hit) => hit.model)
  const weight = (model: Model<Api>): number => {
    const ref = refOf(model)
    const favorite = settings.favorites.findIndex((entry) => same(entry, ref))
    if (favorite !== -1) return favorite
    const recent = settings.recent.findIndex((entry) => same(entry, ref))
    if (recent !== -1) return settings.favorites.length + recent
    if (current !== undefined && same(current, ref)) return settings.favorites.length + settings.recent.length
    return Number.MAX_SAFE_INTEGER
  }
  return filtered.toSorted(
    (left, right) =>
      weight(left) - weight(right) || left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  )
}

// A tool call mints its own command id, so a rerun after a restart reuses the receipt.
const commandId = (value: string): CommandId => value as CommandId

export function create(deps: ModelsPort): ModelsParts {
  const { db, harness, run } = deps
  const recordUsage = usageRecorder(db, harness)
  const flush = async (): Promise<UsageState> => {
    const ledger = await recordUsage()
    await alertSpend(db, deps.notify, deps.alertsOn ?? (async () => true))
    return ledger
  }
  const registry = createRegistry(deps)
  const store = registry.store

  const configure = defineOp({
    name: "conv.configure",
    args: obj({ conv: opt(int({ minimum: 0 })), model: opt(ModelRefSchema), thinking: opt(ThinkingSchema) }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (args.model === undefined && args.thinking === undefined)
        throw new OpRejected("bad_args", "nothing to configure")
      const conversation =
        args.conv === undefined
          ? await api.harness.root(BACKGROUND_CONTEXT)
          : await api.harness.conversation(args.conv as ConversationId, BACKGROUND_CONTEXT)
      if (conversation === undefined) throw new OpRejected("bad_args", `no conversation ${args.conv ?? "root"}`)
      if (!(await canConfigure(api.harness, api.actor, conversation.id)))
        throw new OpRejected("forbidden", "an agent may configure only its own conversation or a thread in its project")
      const change: { model?: ModelRef | null; thinkingLevel?: ModelThinkingLevel | null } = {}
      if (args.model !== undefined) {
        const found = registry.models.getModel(args.model.provider, args.model.modelId)
        if (found === undefined)
          throw new OpRejected("bad_args", `unknown model ${args.model.provider}/${args.model.modelId}`)
        change.model = { provider: args.model.provider, modelId: args.model.modelId }
        if (!found.reasoning) change.thinkingLevel = null
      }
      if (args.thinking !== undefined) {
        const target = args.model ?? (await conversation.agent(BACKGROUND_CONTEXT)).model
        const found = target === undefined ? undefined : registry.models.getModel(target.provider, target.modelId)
        if (found?.reasoning === true) change.thinkingLevel = args.thinking
      }
      await conversation.configure(change satisfies AgentChange, BACKGROUND_CONTEXT)
      if (change.model !== undefined && change.model !== null) await remember(db, change.model)
      const agent = await conversation.agent(BACKGROUND_CONTEXT)
      return {
        conversation: conversation.id,
        model: agent.model ?? null,
        thinking: agent.thinkingLevel,
        effectiveFrom: "next request",
      }
    },
  })

  const list = defineOp({
    name: "models.list",
    args: obj({ query: opt(str()), includeUnkeyed: opt(bool()) }),
    actors: ["owner", "agent"],
    run: async (api, { query, includeUnkeyed }) => {
      const catalog = await available(registry)
      const settings = await readSettings(db)
      const current = await currentModel(api.harness, api.actor)
      const keyedIds = new Set(catalog.map((model) => `${model.provider}/${model.id}`))
      const hasKey = (model: Model<Api>): boolean => keyedIds.has(`${model.provider}/${model.id}`)
      const source = includeUnkeyed === true ? registry.models.getModels() : catalog
      const ordered = ranked(source, settings, current, query)
      // Keyed models come first so the cap never hides one the owner can run.
      const unkeyed = ordered.filter((model) => !hasKey(model))
      const arranged = includeUnkeyed === true ? [...ordered.filter(hasKey), ...unkeyed] : ordered
      const listed = arranged.slice(0, MAX_LISTED)
      return {
        models: listed.map((model) => describe(model, hasKey(model))),
        omittedModels: arranged.length - listed.length,
      }
    },
  })

  const setCredential = defineOp({
    name: "credential.set",
    args: obj({
      provider: str({ minLength: 1, maxLength: 64 }),
      key: opt(str({ minLength: 1 })),
      custom: opt(CustomSchema),
    }),
    actors: ["owner"],
    run: async (_api, args) => {
      let entry: StoredEntry
      if (args.custom !== undefined) {
        if (API_STREAMS[args.custom.api] === undefined)
          throw new OpRejected("bad_args", `unsupported api ${args.custom.api}`)
        entry = {
          credential: { type: "api_key", key: args.custom.key },
          endpoint: { baseUrl: args.custom.baseUrl, api: args.custom.api },
        }
      } else if (args.key !== undefined) {
        entry = { credential: { type: "api_key", key: args.key } }
      } else {
        throw new OpRejected("bad_args", "give either a key or a custom endpoint")
      }
      await store.set(args.provider, entry)
      registry.restore(args.provider)
      return { provider: args.provider, type: "api_key", custom: args.custom !== undefined }
    },
  })

  const deleteCredential = defineOp({
    name: "credential.delete",
    args: obj({ provider: str({ minLength: 1, maxLength: 64 }) }),
    actors: ["owner"],
    run: async (_api, { provider }) => {
      await store.delete(provider)
      registry.restore(provider)
      return { provider, deleted: true }
    },
  })

  const setDefaults = defineOp({
    name: "owner.defaults",
    args: obj({ role: RoleSchema, model: ModelRefSchema }),
    actors: ["owner"],
    run: async (_api, { role, model }) => {
      if (registry.models.getModel(model.provider, model.modelId) === undefined)
        throw new OpRejected("bad_args", `unknown model ${model.provider}/${model.modelId}`)
      const settings = await readSettings(db)
      const defaults: MutableDefaults = { ...settings.defaults }
      defaults[role] = model
      await writeKv(db, "owner.defaults", defaults)
      return { role, model }
    },
  })

  const readCapOp = defineOp({
    name: "usage.cap",
    args: obj({}),
    actors: ["owner"],
    run: async () => ({ usd: await readCap(db) }),
  })

  const setCapOp = defineOp({
    name: "usage.cap.set",
    args: obj({ usd: opt(num({ minimum: 0 })), clear: opt(bool()) }),
    actors: ["owner"],
    run: async (_api, args) => {
      if (args.clear === true) await db.run("DELETE FROM kv WHERE key = ?", USAGE_CAP)
      else if (args.usd !== undefined) await writeKv(db, USAGE_CAP, { usd: args.usd })
      else throw new OpRejected("bad_args", "give usd, or clear to remove the cap")
      return { usd: await readCap(db) }
    },
  })

  const alertOp = defineOp({
    name: "usage.alert",
    args: obj({}),
    actors: ["owner"],
    run: async () => ({ usd: await readDailyAlert(db) }),
  })

  const setAlertOp = defineOp({
    name: "usage.alert.set",
    args: obj({ usd: num({ minimum: 0 }) }),
    actors: ["owner"],
    run: async (_api, args) => {
      await writeKv(db, USAGE_ALERT_USD, { usd: args.usd })
      return { usd: await readDailyAlert(db) }
    },
  })

  const summary = defineOp({
    name: "usage.summary",
    args: obj({}),
    actors: ["owner"],
    run: async () => {
      const ledger = await flush()
      const byModel = Object.entries(ledger.models)
        .map(([key, usage]) => {
          const slash = key.indexOf("/")
          return {
            name: key,
            provider: slash === -1 ? key : key.slice(0, slash),
            modelId: slash === -1 ? "" : key.slice(slash + 1),
            ...bucketOf(usage),
          }
        })
        .toSorted(
          (left, right) =>
            right.cost - left.cost ||
            left.provider.localeCompare(right.provider) ||
            left.modelId.localeCompare(right.modelId),
        )
      const byTool = Object.entries(ledger.tools)
        .map(([name, usage]) => ({ name, ...bucketOf(usage) }))
        .toSorted((left, right) => right.cost - left.cost || left.name.localeCompare(right.name))
      const total = [...byModel, ...byTool].reduce(addUsage, EMPTY_USAGE)
      const dated = await datedUsage(db)
      return {
        spend: total.cost,
        tokens: total.totalTokens,
        today: dated.today,
        month: dated.month,
        days: dated.days,
        cap: await readCap(db),
        alert: await readDailyAlert(db),
        byModel,
        byTool,
        byProject: await projectSpend(harness),
      }
    },
  })

  const service: ModelsService = {
    ownerDefaults: () => ownerDefaults(db),
    vision: async (ref) => {
      const found = registry.models.getModel(ref.provider, ref.modelId)
      return found === undefined ? false : found.input.includes("image")
    },
    credentialSecrets: () => credentialSecrets(db, store),
    spend: async () => ({ month: (await datedUsage(db)).month.spend, cap: await readCap(db) }),
    search: async (query) => {
      const catalog = await available(registry)
      return { catalog, matches: search(catalog, query) }
    },
    switchModel: ({ conversation, caller, model, thinking, callId }) =>
      run(
        {
          id: commandId(`set_model:${callId}`),
          op: "conv.configure",
          args: { conv: conversation, model, ...(thinking === undefined ? {} : { thinking }) },
        },
        { kind: "agent", conversationId: caller },
      ),
  }

  const ops: readonly Op[] = [
    configure,
    list,
    setCredential,
    deleteCredential,
    setDefaults,
    summary,
    readCapOp,
    setCapOp,
    alertOp,
    setAlertOp,
  ]

  return {
    service,
    ops,
    models: () => registry.models,
    flush,
    start: async () => {
      await registry.sync()
      await seedUsage(db, harness)
    },
  }
}
