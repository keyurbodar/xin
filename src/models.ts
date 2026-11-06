import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import {
  createModels,
  createProvider,
  type Api,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
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
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
  type AgentChange,
  type ConversationId,
  type Extension,
  type Harness,
  type ModelRef,
} from "@earendil-works/pi-durable"
import { arr, compile, int, lit, map, num, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema"
import type { CommandId } from "./ids.ts"
import type { HostModule, ModuleDeps } from "./module.ts"
import { defineOp, type Actor, type Op, OpRejected } from "./ops.ts"
import { Sealer } from "./seal.ts"

const MAX_LISTED = 40
const MAX_RECENT = 8

export type Role = "chat" | "thread" | "utility"
export type ModelDefaults = { readonly [K in Role]?: ModelRef }
export type ResolvedModel =
  | { readonly kind: "model"; readonly model: ModelRef; readonly source: "conversation" | "project" | "owner" }
  | { readonly kind: "none" }

export function resolveModel(input: {
  readonly role: Role
  readonly conversation?: ModelRef
  readonly project?: ModelDefaults
  readonly owner?: ModelDefaults
}): ResolvedModel {
  if (input.conversation !== undefined) return { kind: "model", model: input.conversation, source: "conversation" }
  const project = input.project?.[input.role]
  if (project !== undefined) return { kind: "model", model: project, source: "project" }
  const owner = input.owner?.[input.role]
  if (owner !== undefined) return { kind: "model", model: owner, source: "owner" }
  return { kind: "none" }
}

const ModelRefSchema = obj({ provider: str({ minLength: 1 }), modelId: str({ minLength: 1 }) })
const ThinkingSchema = oneOf(["off", "low", "medium", "high"] as const)
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
const SealedSchema = obj({ iv: str(), data: str() })
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
}

function createRegistry(deps: ModuleDeps): Registry {
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider] as const))
  const extra = new Map(deps.providers.map((provider) => [provider.id, provider] as const))
  const custom = new Map<string, Endpoint>()
  const store = new SealedCredentialStore(deps.db, new Sealer(deps.env.KEK), sync)
  const models: MutableModels = createModels({ credentials: store })
  for (const provider of [...builtins.values(), ...extra.values()]) models.setProvider(provider)

  function restore(id: string): void {
    const provider = builtins.get(id) ?? extra.get(id)
    if (provider === undefined) models.deleteProvider(id)
    else models.setProvider(provider)
  }

  async function sync(): Promise<void> {
    const rows = await deps.db.all<{ provider: string }>("SELECT provider FROM credentials ORDER BY provider")
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
      if (previous !== undefined && previous.baseUrl === endpoint.baseUrl && previous.api === endpoint.api) continue
      if (previous !== undefined) restore(id)
      custom.set(id, endpoint)
      models.setProvider(endpointProvider(id, endpoint))
    }
  }

  return { models, store, custom, sync }
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

type Hit = { readonly model: Model<Api>; readonly score: number }

function search(catalog: readonly Model<Api>[], query: string): Hit[] {
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

function describe(model: Model<Api>): JsonValue {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    vision: model.input.includes("image"),
    reasoning: model.reasoning,
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

type Target =
  | { readonly kind: "conversation"; readonly id: number }
  | { readonly kind: "later"; readonly message: string }
  | { readonly kind: "bad"; readonly message: string }

function resolveTarget(target: string, mine: ConversationId): Target {
  if (target === "this_chat") return { kind: "conversation", id: mine }
  if (target.startsWith("thread:")) {
    const id = Number(target.slice("thread:".length))
    return Number.isSafeInteger(id) && id >= 0
      ? { kind: "conversation", id }
      : { kind: "bad", message: `"${target}" is not a thread id` }
  }
  if (target === "new_threads" || target === "project_default")
    return { kind: "later", message: `"${target}" is not available yet; it arrives with projects and threads` }
  return { kind: "bad", message: `unknown target "${target}"` }
}

// A tool call mints its own command id, so a rerun after a restart reuses the receipt.
const commandId = (value: string): CommandId => value as CommandId

export function create(deps: ModuleDeps): HostModule {
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
      if (change.model !== undefined && change.model !== null) await remember(deps.db, change.model)
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
    args: obj({ query: opt(str()) }),
    actors: ["owner", "agent"],
    run: async (api, { query }) => {
      const catalog = await available(registry)
      const settings = await readSettings(deps.db)
      const current = await currentModel(api.harness, api.actor)
      const ordered = ranked(catalog, settings, current, query)
      const listed = ordered.slice(0, MAX_LISTED)
      return { models: listed.map(describe), omittedModels: ordered.length - listed.length }
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
      return { provider: args.provider, type: "api_key", custom: args.custom !== undefined }
    },
  })

  const deleteCredential = defineOp({
    name: "credential.delete",
    args: obj({ provider: str({ minLength: 1, maxLength: 64 }) }),
    actors: ["owner"],
    run: async (_api, { provider }) => {
      await store.delete(provider)
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
      const settings = await readSettings(deps.db)
      const defaults: MutableDefaults = { ...settings.defaults }
      defaults[role] = model
      await writeKv(deps.db, "owner.defaults", defaults)
      return { role, model }
    },
  })

  const setModel = defineTool({
    name: "set_model",
    description: "Switch the model a chat or thread uses. The switch applies from the next request.",
    parameters: obj({
      target: str({ minLength: 1, description: "this_chat, thread:<id>, new_threads or project_default" }),
      query: str({ minLength: 1, description: "model name, id or provider to search for" }),
      thinking: opt(ThinkingSchema),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const target = resolveTarget(args.target, api.conversationId)
      if (target.kind !== "conversation") return { output: [{ type: "text", text: target.message }] }
      const catalog = await available(registry)
      const hits = search(catalog, args.query)
      const top = hits[0]
      if (top === undefined) {
        const words = args.query
          .toLowerCase()
          .split(/\s+/)
          .filter((word) => word.length > 1)
        const close = catalog
          .filter((model) =>
            words.some((word) => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(word)),
          )
          .slice(0, 3)
          .map((model) => `${model.provider}/${model.id} (${model.name})`)
        const hint = close.length > 0 ? `Close matches: ${close.join(", ")}. ` : ""
        const text = `No model matches "${args.query}". ${hint}Ask the owner to add a provider key in Settings.`
        return { output: [{ type: "text", text }], isError: true }
      }
      if (hits.length > 1 && (hits[1]?.score ?? 0) === top.score) {
        const options = hits
          .slice(0, 4)
          .map((hit, index) => `${index + 1}. ${hit.model.provider}/${hit.model.id} (${hit.model.name})`)
        const text = `Which model? Several match "${args.query}": ${options.join("; ")}. Ask the owner which one, then call set_model again with the provider and id.`
        return { output: [{ type: "text", text }] }
      }
      const chosen = top.model
      const outcome = await deps.run(
        {
          id: commandId(`set_model:${api.callId}`),
          op: "conv.configure",
          args: {
            conv: target.id,
            model: refOf(chosen),
            ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
          },
        },
        { kind: "agent", conversationId: api.conversationId },
      )
      if (outcome.kind !== "ok") return { output: [{ type: "text", text: outcome.message }], isError: true }
      const vision = chosen.input.includes("image")
      const notes = [
        vision ? undefined : "This model can't see images; they become placeholders.",
        chosen.reasoning ? undefined : "It has no reasoning, so thinking is off.",
      ].filter((note): note is string => note !== undefined)
      const text = [
        `Set ${chosen.provider}/${chosen.id} (${chosen.name}, ${chosen.contextWindow} tokens). It applies from the next request.`,
        ...notes,
      ].join(" ")
      return {
        output: [{ type: "text", text }],
        details: {
          model: refOf(chosen),
          contextWindow: chosen.contextWindow,
          vision,
          reasoning: chosen.reasoning,
          effectiveFrom: "next request",
        },
      }
    },
  })

  const extension: Extension = defineExtension({ name: "models", tools: [setModel] })
  const ops: readonly Op[] = [configure, list, setCredential, deleteCredential, setDefaults]

  return {
    models: () => registry.models,
    extensions: [extension],
    ops,
    start: () => registry.sync(),
  }
}
