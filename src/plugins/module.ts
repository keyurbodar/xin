import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import {
  defineExtension,
  type Extension,
  hook,
  type JsonObject,
  type Registry,
  type ToolExecutionResult,
  ToolTask,
} from "@earendil-works/pi-durable"
import { bool, compile, obj, type Schema, str, unknown, type Validator } from "@earendil-works/pi-schema"
import type { CommandId, PluginId } from "../ids.ts"
import { type Actor, type Command, defineOp, type Op, type Outcome, OpRejected } from "../ops.ts"
import { Sealer } from "../seal.ts"
import {
  type Manifest,
  type Plugin,
  type PluginHost,
  pluginHost,
  type Reconciled,
  reconcile,
  stateError,
} from "./host.ts"
import { PluginSecrets } from "./secrets.ts"

const REDACTED = "[redacted]"

const pluginCommandId = (pluginId: PluginId, key: string): CommandId => {
  if (key.length === 0) throw new Error("plugin op key is empty")
  return `plugin:${pluginId}:${key}` as CommandId
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const redact = (text: string, secrets: readonly string[]): string => {
  let redacted = text
  for (const secret of secrets) redacted = redacted.split(secret).join(REDACTED)
  return redacted
}

const redactValue = (value: JsonValue, secrets: readonly string[]): JsonValue => {
  if (typeof value === "string") return redact(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]))
  return value
}

const redactResult = (result: ToolExecutionResult, secrets: readonly string[]): ToolExecutionResult => ({
  ...result,
  ...(result.output === undefined
    ? {}
    : {
        output: result.output.map((part) =>
          part.type === "text" ? { ...part, text: redact(part.text, secrets) } : part,
        ),
      }),
  ...(result.structuredOutput === undefined ? {} : { structuredOutput: redactValue(result.structuredOutput, secrets) }),
  ...(result.details === undefined ? {} : { details: redactValue(result.details, secrets) }),
})

export function redactionExtension(secrets: () => readonly string[]): Extension {
  return defineExtension({
    name: "core.redaction",
    hooks: [
      hook(ToolTask, {
        afterTool: (_call, result) => {
          const values = secrets()
          return values.length === 0 ? result : redactResult(result, values)
        },
      }),
    ],
  })
}

export type PluginRuntimeOptions = {
  readonly db: SqliteDatabase
  readonly kek: string
  readonly plugins: readonly Plugin[]
  readonly core: readonly Op[]
  readonly registry: Registry
  readonly run: (command: Command, actor: Actor) => Promise<Outcome>
  publish(): Promise<void>
}

export class PluginRuntime {
  readonly #ops = new Map<string, Op>()
  readonly #db: SqliteDatabase
  readonly #plugins: readonly Plugin[]
  readonly #registry: Registry
  readonly #publish: () => Promise<void>
  readonly #secrets: PluginSecrets
  readonly #reserved: ReadonlySet<string>
  readonly #configChecks = new Map<PluginId, Validator<unknown>>()
  readonly #run: (command: Command, actor: Actor) => Promise<Outcome>
  #reconciled: Reconciled = { states: new Map(), extensions: [], ops: new Map() }

  private constructor(options: PluginRuntimeOptions) {
    this.#db = options.db
    this.#plugins = options.plugins
    this.#registry = options.registry
    this.#run = options.run
    this.#publish = () => options.publish()
    this.#secrets = new PluginSecrets(options.db, new Sealer(options.kek))
    for (const op of [...this.#management(), ...options.core]) {
      if (this.#ops.has(op.name)) throw new Error(`op ${op.name} is already provided`)
      this.#ops.set(op.name, op)
    }
    this.#reserved = new Set(this.#ops.keys())
  }

  get ops(): ReadonlyMap<string, Op> {
    return this.#ops
  }

  get reconciled(): Reconciled {
    return this.#reconciled
  }

  static async open(options: PluginRuntimeOptions): Promise<PluginRuntime> {
    const runtime = new PluginRuntime(options)
    await runtime.#start()
    return runtime
  }

  async #start(): Promise<void> {
    await this.#secrets.load()
    this.#registry.install(redactionExtension(() => this.#secrets.values()))
    await this.#refresh()
  }

  async #refresh(): Promise<void> {
    const rows = await this.#db.all<{ id: string; enabled: number; config: string }>(
      "SELECT id, enabled, config FROM plugins",
    )
    const disabled = new Set(rows.filter((row) => row.enabled === 0).map((row) => row.id))
    const configs = new Map<string, JsonObject>()
    for (const row of rows) configs.set(row.id, parseConfig(row.config))
    const fresh = reconcile(
      this.#plugins,
      (id) => !disabled.has(id),
      (manifest) => this.#host(manifest, configs.get(manifest.id) ?? {}),
      this.#reserved,
    )
    this.#apply(fresh)
    await this.#persist(fresh)
  }

  #apply(fresh: Reconciled): void {
    const names = new Set(fresh.extensions.map((extension) => extension.name))
    for (const extension of this.#reconciled.extensions) {
      if (!names.has(extension.name)) this.#registry.uninstall(extension)
    }
    for (const extension of fresh.extensions) this.#registry.install(extension)
    for (const name of this.#ops.keys()) {
      if (!this.#reserved.has(name)) this.#ops.delete(name)
    }
    for (const [name, op] of fresh.ops) this.#ops.set(name, op)
    this.#reconciled = fresh
  }

  async #persist(fresh: Reconciled): Promise<void> {
    for (const [id, state] of fresh.states)
      await this.#db.run(
        "INSERT INTO plugins (id, state, error) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, error = excluded.error",
        id,
        state.kind,
        stateError(state) ?? null,
      )
  }

  #host(manifest: Manifest, stored: JsonObject): PluginHost {
    let config: JsonObject = {}
    if (manifest.config !== undefined) {
      const validator = this.#configValidator(manifest.id, manifest.config)
      if (!validator.check(stored)) {
        const message = validator
          .errors(stored)
          .map((error) => `${error.path} ${error.message}`)
          .join("; ")
        throw new Error(`bad config for ${manifest.id}: ${message}`)
      }
      config = stored
    }
    const secrets = new Map<string, string>()
    for (const spec of manifest.secrets ?? []) {
      const value = this.#secrets.forPlugin(manifest.id).get(spec.key)
      if (value !== undefined) secrets.set(spec.key, value)
    }
    return pluginHost(manifest, undefined, {
      config,
      secrets,
      run: (key, name, args) => this.#runPlugin(manifest.id, key, name, args),
    })
  }

  #configValidator(id: PluginId, schema: Schema<unknown>): Validator<unknown> {
    const cached = this.#configChecks.get(id)
    if (cached !== undefined) return cached
    const validator = compile(schema)
    this.#configChecks.set(id, validator)
    return validator
  }

  async #runPlugin(pluginId: PluginId, key: string, name: string, args: JsonValue | undefined): Promise<Outcome> {
    return this.#run({ id: pluginCommandId(pluginId, key), op: name, args: args ?? {} }, { kind: "plugin", pluginId })
  }

  #require(id: string): Plugin {
    const plugin = this.#plugins.find((candidate) => candidate.manifest.id === id)
    if (plugin === undefined) throw new OpRejected("bad_args", `no plugin ${id}`)
    return plugin
  }

  #management(): readonly Op[] {
    return [
      defineOp({
        name: "plugin.enable",
        args: obj({ id: str(), enabled: bool() }),
        actors: ["owner"],
        run: async (_api, args) => {
          await this.#enable(args.id, args.enabled)
          return null
        },
      }),
      defineOp({
        name: "plugin.configure",
        args: obj({ id: str(), config: unknown() }),
        actors: ["owner"],
        run: async (_api, args) => {
          await this.#configure(args.id, args.config)
          return null
        },
      }),
      defineOp({
        name: "plugin.secret.set",
        args: obj({ id: str(), key: str(), value: str() }),
        actors: ["owner"],
        run: async (_api, args) => {
          await this.#setSecret(args.id, args.key, args.value)
          return null
        },
      }),
    ]
  }

  async #enable(id: string, enabled: boolean): Promise<void> {
    const { manifest } = this.#require(id)
    await this.#db.run(
      "INSERT INTO plugins (id, enabled) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled",
      manifest.id,
      enabled ? 1 : 0,
    )
    await this.#refresh()
    await this.#publish()
  }

  async #configure(id: string, config: unknown): Promise<void> {
    const { manifest } = this.#require(id)
    if (manifest.config === undefined) throw new OpRejected("bad_args", `plugin ${id} has no config`)
    const validator = this.#configValidator(manifest.id, manifest.config)
    if (!validator.check(config)) {
      const message = validator
        .errors(config)
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")
      throw new OpRejected("bad_args", `bad config for ${id}: ${message}`)
    }
    if (!isJsonObject(config)) throw new OpRejected("bad_args", `bad config for ${id}: not an object`)
    await this.#db.run(
      "INSERT INTO plugins (id, config) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET config = excluded.config",
      manifest.id,
      JSON.stringify(config),
    )
    await this.#refresh()
    await this.#publish()
  }

  async #setSecret(id: string, key: string, value: string): Promise<void> {
    const { manifest } = this.#require(id)
    if (!(manifest.secrets ?? []).some((secret) => secret.key === key))
      throw new OpRejected("bad_args", `plugin ${id} declares no secret ${key}`)
    await this.#secrets.set(manifest.id, key, value)
    await this.#refresh()
    await this.#publish()
  }
}

const parseConfig = (raw: string): JsonObject => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  return isJsonObject(parsed) ? parsed : {}
}
