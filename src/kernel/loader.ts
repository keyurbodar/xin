import { Context, type Fiber, type Plugin, symbols } from "@deepseek-ai/cordis"
import { Loader } from "@deepseek-ai/cordis-plugin-loader"
import { normalizePatch } from "./bundlepatch.ts"
import { configSchemaOf } from "./config.ts"
import { readBundles, bundleRows, type BundleFailure, type RuntimeBundle } from "./bundles.ts"
import {
  applyPatches,
  compose,
  departures,
  pluginOf,
  type Patch,
  type Profile,
  type Row,
  type RowTrace,
} from "./layers.ts"
import {
  checkManifest,
  covers,
  DEFAULT_MANIFEST,
  describeProblem,
  grants,
  injectOf,
  permissionFor,
  PROVIDED,
  requiresPlugin,
  type Manifest,
  type ManifestProblem,
  type Permission,
} from "./manifest.ts"
import { sourcePackage, sourceVersion } from "./packages.ts"
import { FOR_ROW } from "../contracts/rowbound.ts"
import { facade, providedFacade } from "./facade.ts"
import { readOwnerPatch, writeOwnerPatch } from "./patch.ts"
import type { Runtime } from "./types.ts"

export type CatalogEntry = {
  readonly plugin: Plugin
  readonly title: string
  readonly description: string
  readonly required?: boolean
  readonly local?: boolean
  readonly source: string
  readonly manifest?: Manifest
}

export type Catalog = Readonly<Record<string, CatalogEntry>>

export type RowState =
  | { readonly kind: "active" }
  | { readonly kind: "pending" }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "missing" }

export type Composition = {
  readonly catalog: Catalog
  readonly bundles: Readonly<Record<string, readonly Row[]>>
  readonly profile: Profile
  readonly version: string
}

export type IngleLoaderConfig = {
  readonly baseUrl: string
  readonly composition: Composition
  readonly runtime: readonly RuntimeBundle[]
  readonly owner: readonly Patch[]
  readonly warnings: readonly string[]
  persist(patch: readonly Patch[]): void
}

const CORDIS_FIBER_ACTIVE = 2
const CORDIS_FIBER_FAILED = 3

const failure = async (fiber: Fiber): Promise<string> =>
  fiber.await().then(
    () => "failed to start",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

const changedRow = (left: Row, right: Row): boolean =>
  left.disabled !== right.disabled || JSON.stringify(left.config ?? null) !== JSON.stringify(right.config ?? null)

export class IngleLoader extends Loader {
  override internal = undefined
  readonly composition: Composition
  readonly warnings: string[]
  readonly compiled: ReadonlySet<string>
  private lowerRows: Row[]
  private lowerTrace: ReadonlyMap<string, RowTrace>
  private rowTrace: ReadonlyMap<string, RowTrace>
  private runtimeBundles: readonly RuntimeBundle[]
  private readonly initial: readonly Row[]
  private readonly persistPatch: (patch: readonly Patch[]) => void
  private missing: Row[]
  private blocked: Row[] = []
  private unresolved: readonly Patch[]
  private runtimeUnresolved: readonly Patch[] = []
  private mounted = false
  private quiet = false
  private readonly permissions = new Map<string, readonly Permission[]>()
  private readonly trusted = new WeakSet<object>()

  constructor(ctx: Context, config: IngleLoaderConfig) {
    super(ctx, { baseUrl: config.baseUrl })
    this.composition = config.composition
    this.warnings = [...config.warnings]
    this.compiled = new Set(
      Object.values(config.composition.catalog).flatMap((entry) => {
        const name = sourcePackage(entry.source)
        return name.startsWith("ingle") ? [name, `xin${name.slice("ingle".length)}`] : [name]
      }),
    )
    this.runtimeBundles = config.runtime.filter((bundle) => !this.compiled.has(bundle.package))
    for (const [name, entry] of Object.entries(config.composition.catalog)) this.builtins[name] = entry.plugin
    const lower = this.lowerOf(config.runtime)
    this.lowerRows = lower.rows
    this.lowerTrace = lower.trace
    const applied = applyPatches(lower.rows, config.owner, (message) => this.warn(message), "owner", lower.trace)
    this.initial = applied.rows
    this.rowTrace = applied.trace
    this.unresolved = applied.unresolved
    this.missing = applied.rows.filter((row) => !this.has(row))
    this.persistPatch = config.persist
    const pluginRowOf = (fiber: Fiber): string | undefined => this.pluginRow(fiber)
    ctx.on("internal/listener", function (this: Context, name: unknown) {
      if (typeof name !== "string" || !name.startsWith("internal/")) return
      const id = pluginRowOf(this.fiber)
      if (id !== undefined) throw new Error(`${id} may not listen to ${name}; only the kernel may`)
    })
    ctx.on("internal/get", (target: Context, service: string, _error: Error, next: () => unknown) => {
      this.refuse(target, service)
      return this.handOut(target, service, next())
    })
    const reflect: Context["reflect"] = Reflect.get(ctx.reflect, symbols.original)
    const get = reflect.get
    const serve = (caller: Context, service: string, value: unknown): unknown => {
      this.refuse(caller, service)
      return this.handOut(caller, service, value)
    }
    reflect.get = function (this: Context["reflect"], name: string, strict?: boolean): unknown {
      return serve(this.ctx, name, get.call(this, name, strict))
    }
    const root = ctx.root
    Object.defineProperty(this.ctx, "root", {
      get(this: Context): Context {
        return pluginRowOf(this.fiber) === undefined ? root : root.extend({ fiber: this.fiber })
      },
    })
  }

  get lower(): readonly Row[] {
    return this.lowerRows
  }

  get runtime(): readonly RuntimeBundle[] {
    return this.runtimeBundles
  }

  get trace(): ReadonlyMap<string, RowTrace> {
    return this.rowTrace
  }

  has(row: Row): boolean {
    return this.composition.catalog[pluginOf(row)] !== undefined
  }

  override commit(): void {
    if (!this.mounted || this.quiet) return
    const patch = this.ownerPatch()
    this.persistPatch(patch)
    this.rowTrace = applyPatches(this.lowerRows, patch, (message) => this.warn(message), "owner", this.lowerTrace).trace
    this.ctx.emit("plugins/changed")
  }

  rows(): readonly Row[] {
    return [...this.root.data, ...this.blocked, ...this.missing]
  }

  manifestOf(row: Row): Manifest {
    return this.composition.catalog[pluginOf(row)]?.manifest ?? DEFAULT_MANIFEST
  }

  /** The plugin a mounted row belongs to, or undefined when the row is not in this tree. */
  pluginOfRow(id: string): string | undefined {
    const row = this.rows().find((candidate) => candidate.id === id)
    return row === undefined ? undefined : pluginOf(row)
  }

  /** Why this build cannot mount the row, from the plugin's declaration. */
  problemOf(row: Row): ManifestProblem | undefined {
    if (!this.has(row)) return undefined
    const entry = this.composition.catalog[pluginOf(row)]
    return checkManifest(
      this.manifestOf(row),
      (name) => {
        const required = this.composition.catalog[name]
        return required === undefined ? undefined : sourceVersion(required.source)
      },
      entry?.manifest === undefined ? [] : injectOf(entry.plugin),
    )
  }

  /** The permissions a row's plugin declares, or undefined for a row with no manifest: kernel code, or not in this tree. */
  permissionsOf(id: string): readonly Permission[] | undefined {
    return this.permissions.get(id)
  }

  private index(rows: readonly Row[]): void {
    this.permissions.clear()
    for (const row of rows) this.indexRow(row)
  }

  private indexRow(row: Row): void {
    const permissions = this.composition.catalog[pluginOf(row)]?.manifest?.permissions
    if (permissions === undefined) this.permissions.delete(row.id)
    else this.permissions.set(row.id, Object.freeze([...permissions]))
  }

  /** The plugin row the code running in `fiber` belongs to, when that row's plugin has a manifest to hold it to. */
  pluginRow(fiber: Fiber): string | undefined {
    const id = this.locate(fiber)
    return id === undefined || !this.permissions.has(id) ? undefined : id
  }

  /** Lets kernel code that runs outside every row, such as the Durable Object host, read guarded services through `ctx`. */
  trust(ctx: Context): void {
    this.trusted.add(ctx)
  }

  /**
   * Throws when code reading through `ctx` may not use `service`. A guarded service resolves only for a kernel row, a
   * plugin row that declares its permission, or a context the kernel trusts; a context that belongs to no row, such as
   * the root or the loader's own, gets none, so a walk up from a row finds nothing.
   */
  refuse(ctx: Context, service: string): void {
    const permission = permissionFor(service)
    if (permission === undefined) return this.refuseProvided(ctx, service)
    const id = this.locate(ctx.fiber)
    if (id === undefined) {
      if (this.trusted.has(ctx)) return
      throw new Error(`the ${service} service is not reachable from outside a row that declares ${permission}`)
    }
    const permissions = this.permissions.get(id)
    if (permissions === undefined || grants(permissions, permission)) return
    throw new Error(`${id} uses the ${service} service without declaring the ${permission} permission`)
  }

  /**
   * Throws when a plugin row reads a service another package's plugin provides without what `PROVIDED` asks: the
   * permission listed for that service, or else a `requires` naming the providing plugin. Kernel services are not
   * refused here.
   */
  private refuseProvided(ctx: Context, service: string): void {
    const id = this.pluginRow(ctx.fiber)
    if (id === undefined) return
    const provider = this.providerOf(ctx, service)
    if (provider === undefined) return
    const reader = this.pluginOfRow(id)
    const plugin = this.pluginOfRow(provider)
    if (reader === undefined || plugin === undefined || this.packageOf(reader) === this.packageOf(plugin)) return
    const permissions = this.permissions.get(id) ?? []
    if (grants(permissions, "runtime")) return
    const needs = PROVIDED[service]
    if (needs !== undefined) {
      if (grants(permissions, needs)) return
      throw new Error(`${id} uses the ${service} service without declaring the ${needs} permission`)
    }
    if (requiresPlugin(this.composition.catalog[reader]?.manifest ?? DEFAULT_MANIFEST, plugin)) return
    throw new Error(`${id} uses the ${service} service from ${plugin} without requiring it`)
  }

  /** The plugin row that provides `service` as `ctx` sees it, or undefined when kernel code or Cordis provides it. */
  private providerOf(ctx: Context, service: string): string | undefined {
    const reflect: unknown = Reflect.get(this.ctx.reflect, symbols.original)
    const store: unknown = typeof reflect === "object" && reflect !== null ? Reflect.get(reflect, "store") : undefined
    const key: unknown = Reflect.get(ctx[symbols.isolate], service)
    if (typeof store !== "object" || store === null || typeof key !== "symbol") return undefined
    const impl: unknown = Reflect.get(store, key)
    const owner: unknown = typeof impl === "object" && impl !== null ? Reflect.get(impl, "ctx") : undefined
    if (!(owner instanceof Object)) return undefined
    return this.pluginRow(Reflect.get(owner, "fiber"))
  }

  private packageOf(plugin: string): string {
    const entry = this.composition.catalog[plugin]
    return entry === undefined ? plugin : sourcePackage(entry.source)
  }

  /**
   * What a plugin row gets for a service read: a Cordis service becomes a frozen facade with no `ctx` and no
   * `cordis.original`, and a service another plugin provides becomes a frozen object of its methods alone, so the row
   * can call either but never reach the kernel context behind it or change what other rows call.
   */
  private handOut(caller: Context, service: string, value: unknown): unknown {
    const id = this.pluginRow(caller.fiber)
    if (id === undefined) return value
    const bind: unknown = typeof value === "object" && value !== null ? Reflect.get(value, FOR_ROW) : undefined
    if (typeof bind === "function") return Object.freeze(Reflect.apply(bind, value, [id]))
    if (this.providerOf(caller, service) !== undefined) return providedFacade(value, caller)
    const credentials = this.composition.catalog[this.pluginOfRow(id) ?? ""]?.manifest?.credentials
    return facade(value, caller, {
      id,
      permissions: this.permissions.get(id) ?? [],
      ...(credentials === undefined ? {} : { credentials }),
    })
  }

  /** Why a row may not register this tool or op: its plugin declares `contributes` and leaves the name out. */
  undeclared(id: string | undefined, kind: "tools" | "ops", name: string): string | undefined {
    if (id === undefined) return undefined
    const plugin = this.pluginOfRow(id)
    const contributes = plugin === undefined ? undefined : this.composition.catalog[plugin]?.manifest?.contributes
    if (contributes === undefined || covers(contributes[kind], name)) return undefined
    return `${plugin} registers ${kind === "tools" ? "tool" : "op"} ${name}, which its manifest's contributes.${kind} does not declare`
  }

  ownerPatch(): Patch[] {
    return [...departures(this.lowerRows, this.rows(), (row) => this.resolveConfig(row)), ...this.unresolved]
  }

  private resolveConfig(row: Row): unknown {
    const schema = configSchemaOf(this.composition.catalog[pluginOf(row)]?.plugin)
    if (schema === undefined) return row.config ?? null
    try {
      return JSON.parse(JSON.stringify(schema(row.config ?? {})))
    } catch {
      return row.config ?? null
    }
  }

  entryOf(id: string): CatalogEntry | undefined {
    const row = this.rows().find((candidate) => candidate.id === id)
    return row === undefined ? undefined : this.composition.catalog[pluginOf(row)]
  }

  required(id: string): boolean {
    return this.entryOf(id)?.required === true
  }

  isMissing(id: string): boolean {
    return this.missing.some((row) => row.id === id)
  }

  async state(id: string): Promise<RowState> {
    const row = this.rows().find((candidate) => candidate.id === id)
    if (row === undefined || this.isMissing(id)) return { kind: "missing" }
    const entry = this.store[id]
    if (entry?.disabled === true || row.disabled === true) return { kind: "disabled" }
    const problem = this.problemOf(row)
    if (problem !== undefined) return { kind: "failed", error: describeProblem(problem) }
    if (entry === undefined) return { kind: "pending" }
    const fiber = entry.fiber
    if (fiber === undefined) return { kind: "pending" }
    const state = Number(fiber.state)
    if (state === CORDIS_FIBER_ACTIVE) return { kind: "active" }
    if (state === CORDIS_FIBER_FAILED) return { kind: "failed", error: await failure(fiber) }
    return { kind: "pending" }
  }

  async brokenRequired(): Promise<BundleFailure[]> {
    const broken: BundleFailure[] = []
    for (const row of this.rows()) {
      if (!this.required(row.id)) continue
      const state = await this.state(row.id)
      if (state.kind !== "active")
        broken.push({ id: row.id, error: state.kind === "failed" ? state.error : state.kind })
    }
    return broken
  }

  override async create(row: Row, parent?: string | null, position?: number): Promise<string> {
    this.indexRow(row)
    return super.create(this.patchedRow(row), parent, position)
  }

  private patchedRow(row: Row): Row {
    const patches = this.runtimeUnresolved.filter((patch) => !("insert" in patch) && patch.id === row.id)
    if (patches.length === 0) return row
    const applied = applyPatches([row], patches, () => undefined, "runtime").rows[0]
    return applied ?? row
  }

  async mount(): Promise<void> {
    this.index(this.initial)
    this.blocked = this.initial.filter((row) => this.has(row) && this.problemOf(row) !== undefined)
    const blocked = new Set(this.blocked.map((row) => row.id))
    for (const row of this.initial) if (this.has(row) && !blocked.has(row.id)) await this.create(row)
    await this.await()
    this.mounted = true
  }

  async recompose(runtime: readonly RuntimeBundle[], owner: readonly Patch[] = this.ownerPatch()): Promise<void> {
    const lower = this.lowerOf(runtime)
    const applied = applyPatches(lower.rows, owner, (message) => this.warn(message), "owner", lower.trace)
    const blocked = applied.rows.filter((row) => this.has(row) && this.problemOf(row) !== undefined)
    const present = applied.rows.filter((row) => this.has(row) && !blocked.includes(row))
    const missing = applied.rows.filter((row) => !this.has(row))
    const mountedRows = [...this.root.data]
    this.index(applied.rows)
    this.quiet = true
    try {
      for (const row of mountedRows) if (!present.some((candidate) => candidate.id === row.id)) this.remove(row.id)
      for (const row of present) {
        const old = mountedRows.find((candidate) => candidate.id === row.id)
        await this.applyRow(old, row).catch(() => undefined)
      }
      await this.await()
    } finally {
      this.quiet = false
    }
    this.lowerRows = lower.rows
    this.lowerTrace = lower.trace
    this.runtimeBundles = runtime.filter((bundle) => !this.compiled.has(bundle.package))
    this.blocked = blocked
    this.missing = missing
    this.unresolved = applied.unresolved
    this.rowTrace = applied.trace
    this.commit()
  }

  private lowerOf(runtime: readonly RuntimeBundle[]): { rows: Row[]; trace: ReadonlyMap<string, RowTrace> } {
    const mounted = runtime.filter((bundle) => !this.compiled.has(bundle.package))
    const applied = compose(
      this.composition.bundles,
      this.composition.profile,
      mounted.map((bundle) => ({
        rows: bundleRows(bundle),
        patch: bundle.patch.map((entry) => normalizePatch(entry)),
      })),
      (message) => this.warn(message),
    )
    this.runtimeUnresolved = applied.unresolved
    return { rows: applied.rows, trace: applied.trace }
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message)
  }

  private async applyRow(old: Row | undefined, row: Row): Promise<void> {
    if (old === undefined) {
      await this.create(row)
      return
    }
    if (old.name !== row.name) {
      this.remove(row.id)
      await this.create(row)
      return
    }
    if (changedRow(old, row)) await this.update(row.id, { config: row.config ?? null, disabled: row.disabled ?? null })
  }
}

export type Kernel = {
  readonly root: Context
  readonly loader: IngleLoader
  readonly failure: string | undefined
}

export async function boot(runtime: Runtime, composition: Composition): Promise<Kernel> {
  const base = new Context()
  let own: Context | undefined
  await base.plugin({
    name: "kernel",
    apply: (ctx: Context) => {
      own = ctx
      ctx.provide("host", runtime)
    },
  })
  if (own === undefined) throw new Error("the kernel fiber did not start")
  const kernelCtx = own
  const storage = runtime.state.storage
  const warnings: string[] = []
  const owner = readOwnerPatch(storage, (message) => void warnings.push(message))
  const runtimeBundles = readBundles(storage, (message) => void warnings.push(message))
  await base.plugin(IngleLoader, {
    baseUrl: "file:///bundle/",
    composition,
    runtime: runtimeBundles,
    owner,
    warnings,
    persist: (patch) => writeOwnerPatch(storage, patch),
  })
  const loader = base.get("loader")
  if (!(loader instanceof IngleLoader)) throw new Error("the loader did not start")
  kernelCtx.provide("kernel", loader)
  const root = base.extend({})
  loader.trust(root)
  await loader.mount()
  const broken = await loader.brokenRequired()
  const harness = root.get("harness")
  const detail = broken.map((row) => `${row.id}: ${row.error}`).join("; ") || "no harness"
  if (broken.length > 0 || harness === undefined)
    return { root, loader, failure: `required rows are not active (${detail})` }
  await root.clock.arm(harness.wake())
  harness.resume()
  return { root, loader, failure: undefined }
}
