import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis"
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
import { checkManifest, DEFAULT_MANIFEST, describeProblem, type Manifest, type ManifestProblem } from "./manifest.ts"
import { sourcePackage, sourceVersion } from "./packages.ts"
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

export type XinLoaderConfig = {
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

export class XinLoader extends Loader {
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

  constructor(ctx: Context, config: XinLoaderConfig) {
    super(ctx, { baseUrl: config.baseUrl })
    this.composition = config.composition
    this.warnings = [...config.warnings]
    this.compiled = new Set(Object.values(config.composition.catalog).map((entry) => sourcePackage(entry.source)))
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
    return checkManifest(this.manifestOf(row), (name) => {
      const entry = this.composition.catalog[name]
      return entry === undefined ? undefined : sourceVersion(entry.source)
    })
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
    return super.create(this.patchedRow(row), parent, position)
  }

  private patchedRow(row: Row): Row {
    const patches = this.runtimeUnresolved.filter((patch) => !("insert" in patch) && patch.id === row.id)
    if (patches.length === 0) return row
    const applied = applyPatches([row], patches, () => undefined, "runtime").rows[0]
    return applied ?? row
  }

  async mount(): Promise<void> {
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
  readonly loader: XinLoader
  readonly failure: string | undefined
}

export async function boot(runtime: Runtime, composition: Composition): Promise<Kernel> {
  const root = new Context()
  root.provide("host", runtime)
  const storage = runtime.state.storage
  const warnings: string[] = []
  const owner = readOwnerPatch(storage, (message) => void warnings.push(message))
  const runtimeBundles = readBundles(storage, (message) => void warnings.push(message))
  await root.plugin(XinLoader, {
    baseUrl: "file:///bundle/",
    composition,
    runtime: runtimeBundles,
    owner,
    warnings,
    persist: (patch) => writeOwnerPatch(storage, patch),
  })
  const loader = root.get("loader")
  if (!(loader instanceof XinLoader)) throw new Error("the loader did not start")
  root.provide("kernel", loader)
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
