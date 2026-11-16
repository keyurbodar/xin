import type { Context } from "@deepseek-ai/cordis"
import type { JsonValue } from "@earendil-works/chord"
import type { JsonObject } from "@earendil-works/pi-durable"
import { bool, obj } from "@earendil-works/pi-schema"
import { defineOp, OpRejected } from "../ops.ts"
import { FragmentId } from "../rowid.ts"
import { configSchemaOf, validateConfig } from "./config.ts"
import { pluginOf, type Layer, type Row } from "./layers.ts"
import type { RowState, IngleLoader } from "./loader.ts"
import { formOf } from "./form.ts"
import {
  checkManifest,
  DEFAULT_MANIFEST,
  injectOf,
  PERMISSIONS,
  type Manifest,
  type ManifestProblem,
} from "./manifest.ts"
import { sourcePackage, sourceVersion } from "./packages.ts"

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
  readonly manifest: Manifest
}

export type Changed = { readonly application: Application; readonly row: RowView }

export type Issue = ManifestProblem | { readonly kind: "failed"; readonly error: string } | { readonly kind: "missing" }

/** What a mounted row registered, read from the live services. */
export type Inventory = { readonly tools: readonly string[]; readonly ops: readonly string[] }

export type Diagnosis = RowView & {
  readonly package: string
  readonly version: string
  readonly registered: Inventory
  readonly issues: readonly Issue[]
}

export type Doctor = { readonly ok: boolean; readonly rows: readonly Diagnosis[] }

export type Manager = {
  list(): Promise<readonly RowView[]>
  catalog(): readonly JsonObject[]
  tree(): JsonObject
  doctor(): Promise<Doctor>
  enable(id: string, enabled: boolean): Promise<Changed>
  configure(id: string, config: JsonObject): Promise<Changed>
}

const ConfigSchema = obj({}, { open: true })

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toJson = (value: unknown): JsonValue => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

const packageOf = (loader: IngleLoader, row: Row): { package: string; version: string } => {
  const entry = loader.composition.catalog[pluginOf(row)]
  return entry === undefined
    ? { package: pluginOf(row), version: "dev" }
    : { package: sourcePackage(entry.source), version: sourceVersion(entry.source) }
}

export function createManager(loader: IngleLoader, inventory: (row: string) => Inventory): Manager {
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
  const versionOf = (plugin: string): string | undefined => {
    const entry = catalog[plugin]
    return entry === undefined ? undefined : sourceVersion(entry.source)
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
      manifest: loader.manifestOf(row),
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
  const diagnose = async (row: Row): Promise<Diagnosis> => {
    const plugin = pluginOf(row)
    const entry = catalog[plugin]
    const { package: pkg, version } = packageOf(loader, row)
    const state = await loader.state(row.id)
    const problem =
      entry === undefined
        ? undefined
        : checkManifest(loader.manifestOf(row), versionOf, entry.manifest === undefined ? [] : injectOf(entry.plugin))
    const issues: Issue[] = []
    if (problem !== undefined) issues.push(problem)
    if (state.kind === "missing") issues.push({ kind: "missing" })
    if (state.kind === "failed" && problem === undefined) issues.push({ kind: "failed", error: state.error })
    return {
      id: row.id,
      plugin,
      title: entry?.title ?? plugin,
      required: entry?.required === true,
      layer: layerAt(row.id),
      disabled: row.disabled === true,
      config: toJson(row.config),
      state,
      manifest: loader.manifestOf(row),
      package: pkg,
      version,
      registered: inventory(row.id),
      issues,
    }
  }
  return {
    list: () => Promise.all(loader.rows().map((row) => view(row))),
    catalog: () =>
      Object.entries(catalog).map(([name, entry]) => {
        const manifest = entry.manifest ?? DEFAULT_MANIFEST
        const schema = configSchemaOf(entry.plugin)
        return {
          name,
          title: entry.title,
          description: entry.description,
          required: entry.required === true,
          source: entry.source,
          version: sourceVersion(entry.source),
          manifest: toJson(manifest),
          permissions: manifest.permissions.map((id) => ({ id, title: PERMISSIONS[id].title })),
          schema: toJson(schema?.toJSON() ?? null),
          form: toJson(formOf(schema)),
        }
      }),
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
    doctor: async () => {
      const rows = await Promise.all(loader.rows().map((row) => diagnose(row)))
      return { ok: rows.every((row) => row.issues.length === 0), rows }
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
export const inject = ["kernel", "ops", "wire", "pi"]

export function apply(ctx: Context): void {
  const { ops, pi } = ctx
  const manager = createManager(ctx.kernel, (row) => ({
    tools: [...pi.installed.values()]
      .filter((installed) => installed.row === row)
      .flatMap((installed) => (installed.extension.tools ?? []).map((tool) => tool.name))
      .toSorted(),
    ops: [...ops.rows].flatMap(([op, owner]) => (owner === row ? [op] : [])).toSorted(),
  }))
  ctx.provide("plugins", manager)
  ctx.wire.home("plugins", async () => ({
    plugins: Object.fromEntries((await manager.list()).map((row) => [row.id, row.state.kind])),
  }))
  const OWNER = ["owner"] as const
  ctx.ops.define(
    defineOp({
      name: "plugin.list",
      read: true,
      args: obj({}),
      actors: OWNER,
      run: async () => toJson(await manager.list()),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "plugin.catalog",
      read: true,
      args: obj({}),
      actors: OWNER,
      run: async () => toJson(manager.catalog()),
    }),
  )
  ctx.ops.define(defineOp({ name: "plugin.tree", args: obj({}), actors: OWNER, run: async () => manager.tree() }))
  ctx.ops.define(
    defineOp({ name: "plugin.doctor", args: obj({}), actors: OWNER, run: async () => toJson(await manager.doctor()) }),
  )
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
      credentials: ["config"],
      run: async (_api, args) => toJson(await manager.configure(args.id, isJsonObject(args.config) ? args.config : {})),
    }),
  )
}
