import type { Context } from "@deepseek-ai/cordis"
import type { JsonValue } from "@earendil-works/chord"
import type { JsonObject } from "@earendil-works/pi-durable"
import { bool, obj, str } from "@earendil-works/pi-schema"
import { defineOp, OpRejected } from "../ops.ts"
import { layerOf, type Row } from "./layers.ts"
import { pluginOf, type RowState, type XinLoader } from "./loader.ts"

export type Application = "applied" | "failed"

export type RowView = {
  readonly id: string
  readonly plugin: string
  readonly title: string
  readonly required: boolean
  readonly layer: "bundle" | "profile" | "owner"
  readonly disabled: boolean
  readonly config: JsonValue
  readonly state: RowState
}

export type Changed = { readonly application: Application; readonly row: RowView }

export type Manager = {
  list(): Promise<readonly RowView[]>
  catalog(): readonly JsonObject[]
  tree(): JsonObject
  enable(id: string, enabled: boolean): Promise<Changed>
  configure(id: string, config: JsonObject): Promise<Changed>
  insert(id: string, plugin: string, config: JsonObject): Promise<Changed>
  remove(id: string): Promise<{ readonly application: Application; readonly id: string }>
  reset(id: string): Promise<Changed>
}

const PluginId = str({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" })
const ConfigSchema = obj({}, { open: true })

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toJson = (value: unknown): JsonValue => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

type ConfigSchemaLike = { (value: unknown): unknown; toJSON(): unknown }

const schemaOf = (plugin: unknown): ConfigSchemaLike | undefined => {
  const schema: unknown =
    typeof plugin === "object" || typeof plugin === "function" ? Reflect.get(plugin ?? {}, "Config") : undefined
  return typeof schema === "function" && "toJSON" in schema && typeof schema.toJSON === "function"
    ? (schema as ConfigSchemaLike)
    : undefined
}

function validate(plugin: string, schema: ConfigSchemaLike, config: JsonObject): void {
  try {
    schema(config)
  } catch (error) {
    throw new OpRejected("bad_args", `config for ${plugin}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function createManager(loader: XinLoader): Manager {
  const { catalog, profile } = loader.composition
  const find = (id: string): Row => {
    const row = loader.rows().find((candidate) => candidate.id === id)
    if (row === undefined) throw new OpRejected("bad_args", `no plugin row ${id}`)
    return row
  }
  const view = async (row: Row): Promise<RowView> => {
    const plugin = pluginOf(row)
    const entry = catalog[plugin]
    return {
      id: row.id,
      plugin,
      title: entry?.title ?? plugin,
      required: entry?.required === true,
      layer: layerOf(row.id, profile, loader.ownerPatch()),
      disabled: row.disabled === true,
      config: toJson(row.config),
      state: await loader.state(row.id),
    }
  }
  const changed = async (id: string): Promise<Changed> => {
    await loader.await()
    const row = await view(find(id))
    return { application: row.state.kind === "failed" ? "failed" : "applied", row }
  }
  const attempt = async (id: string, work: () => Promise<void>): Promise<Changed> => {
    const thrown = await work().then(
      () => undefined,
      (error: unknown) => ({ error }),
    )
    const result = await changed(id)
    if (thrown !== undefined && result.application !== "failed") throw thrown.error
    return result
  }
  const ensurePresent = (id: string): void => {
    if (loader.isMissing(id)) throw new OpRejected("bad_args", `${id} has no code in this build`)
  }
  return {
    list: () => Promise.all(loader.rows().map(view)),
    catalog: () =>
      Object.entries(catalog).map(([name, entry]) => ({
        name,
        title: entry.title,
        description: entry.description,
        required: entry.required === true,
        source: entry.source,
        schema: toJson(schemaOf(entry.plugin)?.toJSON() ?? null),
      })),
    tree: () => ({
      bundles: [...profile.bundles],
      lower: toJson(loader.lower),
      owner: toJson(loader.ownerPatch()),
      rows: toJson(loader.rows()),
      warnings: [...loader.warnings],
    }),
    enable: async (id, enabled) => {
      find(id)
      if (!enabled && loader.required(id)) throw new OpRejected("bad_args", `${id} is required and cannot be disabled`)
      ensurePresent(id)
      return attempt(id, () => loader.update(id, { disabled: !enabled }))
    },
    configure: async (id, config) => {
      const plugin = pluginOf(find(id))
      ensurePresent(id)
      const schema = schemaOf(catalog[plugin]?.plugin)
      if (schema === undefined) throw new OpRejected("bad_args", `${plugin} has no config schema`)
      validate(plugin, schema, config)
      return attempt(id, () => loader.update(id, { config }))
    },
    insert: async (id, plugin, config) => {
      if (loader.rows().some((row) => row.id === id)) throw new OpRejected("bad_args", `row ${id} already exists`)
      const entry = catalog[plugin]
      if (entry === undefined) throw new OpRejected("bad_args", `no plugin ${plugin} in this build`)
      if (entry.required === true) throw new OpRejected("bad_args", `${plugin} is required and is always present`)
      if (entry.multiple !== true && loader.rows().some((row) => pluginOf(row) === plugin))
        throw new OpRejected("bad_args", `a ${plugin} row already exists`)
      const schema = schemaOf(entry.plugin)
      if (schema !== undefined) validate(plugin, schema, config)
      const row: Row = { id, name: `cordis:${plugin}`, config }
      return attempt(id, async () => void (await loader.create(row)))
    },
    remove: async (id) => {
      find(id)
      if (loader.lower.some((row) => row.id === id))
        throw new OpRejected("bad_args", `${id} comes from a bundle; disable it instead`)
      if (loader.isMissing(id)) {
        loader.dropMissing(id)
        return { application: "applied", id }
      }
      loader.remove(id)
      await loader.await()
      return { application: "applied", id }
    },
    reset: async (id) => {
      find(id)
      ensurePresent(id)
      const base = loader.lower.find((row) => row.id === id)
      if (base === undefined) throw new OpRejected("bad_args", `${id} was added by the owner; remove it instead`)
      return attempt(id, () => loader.update(id, { config: base.config, disabled: base.disabled ?? false }))
    },
  }
}

export const name = "plugins"
export const inject = ["kernel", "ops", "wire"]

export function apply(ctx: Context): void {
  const manager = createManager(ctx.kernel)
  ctx.provide("plugins", manager)
  ctx.wire.home("plugins", async () => ({
    plugins: Object.fromEntries((await manager.list()).map((row) => [row.id, row.state.kind])),
  }))
  const OWNER = ["owner"] as const
  ctx.ops.define(
    defineOp({ name: "plugin.list", args: obj({}), actors: OWNER, run: async () => toJson(await manager.list()) }),
  )
  ctx.ops.define(
    defineOp({ name: "plugin.catalog", args: obj({}), actors: OWNER, run: async () => toJson(manager.catalog()) }),
  )
  ctx.ops.define(defineOp({ name: "plugin.tree", args: obj({}), actors: OWNER, run: async () => manager.tree() }))
  ctx.ops.define(
    defineOp({
      name: "plugin.enable",
      args: obj({ id: PluginId, enabled: bool() }),
      actors: OWNER,
      run: async (_api, args) => toJson(await manager.enable(args.id, args.enabled)),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.configure",
      args: obj({ id: PluginId, config: ConfigSchema }),
      actors: OWNER,
      run: async (_api, args) => toJson(await manager.configure(args.id, isJsonObject(args.config) ? args.config : {})),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.insert",
      args: obj({ id: PluginId, plugin: str({ minLength: 1 }), config: ConfigSchema }),
      actors: OWNER,
      run: async (_api, args) =>
        toJson(await manager.insert(args.id, args.plugin, isJsonObject(args.config) ? args.config : {})),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.remove",
      args: obj({ id: PluginId }),
      actors: OWNER,
      run: async (_api, args) => toJson(await manager.remove(args.id)),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.reset",
      args: obj({ id: PluginId }),
      actors: OWNER,
      run: async (_api, args) => toJson(await manager.reset(args.id)),
    }),
  )
}
