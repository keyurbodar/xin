import type { Context } from "@deepseek-ai/cordis"
import type { JsonValue } from "@earendil-works/chord"
import type { JsonObject } from "@earendil-works/pi-durable"
import { bool, obj } from "@earendil-works/pi-schema"
import { defineOp, OpRejected } from "../ops.ts"
import { FragmentId } from "../rowid.ts"
import { configSchemaOf, validateConfig } from "./config.ts"
import { pluginOf, type Layer, type Row } from "./layers.ts"
import type { RowState, XinLoader } from "./loader.ts"

export type Application = "applied" | "failed"

export type RowView = {
  readonly id: string
  readonly plugin: string
  readonly title: string
  readonly required: boolean
  readonly layer: Layer
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
}

const ConfigSchema = obj({}, { open: true })

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toJson = (value: unknown): JsonValue => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

export function createManager(loader: XinLoader): Manager {
  const { catalog, profile } = loader.composition
  const find = (id: string): Row => {
    const row = loader.rows().find((candidate) => candidate.id === id)
    if (row === undefined) throw new OpRejected("bad_args", `no plugin row ${id}`)
    return row
  }
  const layerAt = (id: string): Layer => {
    const trace = loader.trace.get(id)
    return trace === undefined ? "bundle" : (trace.patchedBy.at(-1) ?? trace.addedBy)
  }
  const view = async (row: Row): Promise<RowView> => {
    const plugin = pluginOf(row)
    const entry = catalog[plugin]
    return {
      id: row.id,
      plugin,
      title: entry?.title ?? plugin,
      required: entry?.required === true,
      layer: layerAt(row.id),
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
    list: () => Promise.all(loader.rows().map((row) => view(row))),
    catalog: () =>
      Object.entries(catalog).map(([name, entry]) => ({
        name,
        title: entry.title,
        description: entry.description,
        required: entry.required === true,
        source: entry.source,
        schema: toJson(configSchemaOf(entry.plugin)?.toJSON() ?? null),
      })),
    tree: () => {
      return {
        bundles: [...profile.bundles],
        runtime: loader.runtime.map((bundle) => ({
          package: bundle.package,
          source: toJson(bundle.source),
          requires: [...bundle.requires],
          rows: bundle.rows.map((row) => row.id),
          patch: bundle.patch.map((entry) => entry.id),
        })),
        layers: toJson(Object.fromEntries(loader.trace)),
        lower: toJson(loader.lower),
        owner: toJson(loader.ownerPatch()),
        rows: toJson(loader.rows()),
        warnings: [...loader.warnings],
      }
    },
    enable: async (id, enabled) => {
      find(id)
      if (!enabled && loader.required(id)) throw new OpRejected("bad_args", `${id} is required and cannot be disabled`)
      ensurePresent(id)
      return attempt(id, () => loader.update(id, { disabled: !enabled }))
    },
    configure: async (id, config) => {
      const plugin = pluginOf(find(id))
      ensurePresent(id)
      const schema = configSchemaOf(catalog[plugin]?.plugin)
      if (schema === undefined) throw new OpRejected("bad_args", `${plugin} has no config schema`)
      validateConfig(plugin, schema, config)
      return attempt(id, () => loader.update(id, { config }))
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
      args: obj({ id: FragmentId, enabled: bool() }),
      actors: OWNER,
      run: async (_api, args) => toJson(await manager.enable(args.id, args.enabled)),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.configure",
      args: obj({ id: FragmentId, config: ConfigSchema }),
      actors: OWNER,
      run: async (_api, args) => toJson(await manager.configure(args.id, isJsonObject(args.config) ? args.config : {})),
    }),
  )
}
