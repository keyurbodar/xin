import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis"
import { Loader } from "@deepseek-ai/cordis-plugin-loader"
import {
  readBundles,
  reconcileActiveSetup,
  runtimeRows,
  writeActiveSetup,
  type BundleFailure,
  type RuntimeBundle,
} from "./bundles.ts"
import { normalizePatch } from "./bundlepatch.ts"
import { applyPatches, compose, departures, pluginOf, type Patch, type Profile, type Row } from "./layers.ts"
import { sourcePackage } from "./packages.ts"
import { readOwnerPatch, writeOwnerPatch } from "./patch.ts"
import { isRuntimeRowId } from "../rowid.ts"
import type { Runtime } from "./types.ts"

export type CatalogEntry = {
  readonly plugin: Plugin
  readonly title: string
  readonly description: string
  readonly required?: boolean
  readonly multiple?: boolean
  readonly local?: boolean
  readonly source: string
}

export type Catalog = Readonly<Record<string, CatalogEntry>>

export type RowState =
  | { readonly kind: "active" }
  | { readonly kind: "pending" }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "missing" }
  | { readonly kind: "superseded" }

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

function duplicateFailures(rows: readonly Row[], catalog: Catalog): Map<string, string> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const plugin = pluginOf(row)
    counts.set(plugin, (counts.get(plugin) ?? 0) + 1)
  }
  const failed = new Map<string, string>()
  for (const row of rows) {
    const plugin = pluginOf(row)
    const entry = catalog[plugin]
    if (entry === undefined || entry.multiple === true) continue
    if ((counts.get(plugin) ?? 0) < 2) continue
    if (isRuntimeRowId(row.id)) failed.set(row.id, `a ${plugin} row already exists in this tree`)
  }
  return failed
}

export class XinLoader extends Loader {
  override internal = undefined
  readonly composition: Composition
  readonly warnings: string[]
  readonly compiled: ReadonlySet<string>
  private lowerRows: Row[]
  private runtimeBundles: readonly RuntimeBundle[]
  private readonly initial: readonly Row[]
  private readonly persistPatch: (patch: readonly Patch[]) => void
  private missing: Row[]
  private rejected: ReadonlyMap<string, string>
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
    this.lowerRows = this.lowerOf(config.runtime)
    const applied = applyPatches(this.lowerRows, config.owner, (message) => this.warn(message))
    this.initial = applied.rows
    this.rejected = duplicateFailures(this.initial, this.composition.catalog)
    this.unresolved = applied.unresolved
    this.missing = applied.rows.filter((row) => !this.has(row) || this.rejected.has(row.id))
    this.persistPatch = config.persist
  }

  get lower(): readonly Row[] {
    return this.lowerRows
  }

  get runtime(): readonly RuntimeBundle[] {
    return this.runtimeBundles
  }

  isSuperseded(pkg: string): boolean {
    return this.compiled.has(pkg)
  }

  has(row: Row): boolean {
    return this.composition.catalog[pluginOf(row)] !== undefined
  }

  override commit(): void {
    if (!this.mounted || this.quiet) return
    this.persistPatch(this.ownerPatch())
    this.ctx.emit("plugins/changed")
  }

  rows(): readonly Row[] {
    return [...this.root.data, ...this.missing]
  }

  ownerPatch(): Patch[] {
    return [...departures(this.lowerRows, this.rows()), ...this.unresolved]
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

  dropMissing(id: string): void {
    this.missing = this.missing.filter((row) => row.id !== id)
    this.commit()
  }

  async state(id: string): Promise<RowState> {
    const rejected = this.rejected.get(id)
    if (rejected !== undefined) return { kind: "failed", error: rejected }
    const entry = this.store[id]
    if (entry === undefined || this.isMissing(id)) return { kind: "missing" }
    if (entry.disabled) return { kind: "disabled" }
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
    const applied = applyPatches([row], patches, () => undefined).rows[0]
    return applied ?? row
  }

  async mount(): Promise<void> {
    for (const row of this.initial) if (this.has(row) && !this.rejected.has(row.id)) await this.create(row)
    await this.await()
    this.mounted = true
  }

  async recompose(runtime: readonly RuntimeBundle[], owner: readonly Patch[] = this.ownerPatch()): Promise<void> {
    const lower = this.lowerOf(runtime)
    const applied = applyPatches(lower, owner, (message) => this.warn(message))
    const rejected = duplicateFailures(applied.rows, this.composition.catalog)
    const present = applied.rows.filter((row) => this.has(row) && !rejected.has(row.id))
    const missing = applied.rows.filter((row) => !this.has(row) || rejected.has(row.id))
    const previous = [...this.root.data]
    this.quiet = true
    try {
      for (const row of previous) if (!present.some((candidate) => candidate.id === row.id)) this.remove(row.id)
      for (const row of present) {
        const old = previous.find((candidate) => candidate.id === row.id)
        await this.applyRow(old, row).catch(() => undefined)
      }
      await this.await()
    } finally {
      this.quiet = false
    }
    this.lowerRows = lower
    this.runtimeBundles = runtime.filter((bundle) => !this.compiled.has(bundle.package))
    this.rejected = rejected
    this.missing = missing
    this.unresolved = applied.unresolved
    this.commit()
  }

  private lowerOf(runtime: readonly RuntimeBundle[]): Row[] {
    const mounted = runtime.filter((bundle) => !this.compiled.has(bundle.package))
    const applied = compose(
      this.composition.bundles,
      this.composition.profile,
      runtimeRows(mounted),
      mounted.flatMap((bundle) => bundle.patch.map((entry) => normalizePatch(entry))),
      (message) => this.warn(message),
    )
    this.runtimeUnresolved = applied.unresolved
    return applied.rows
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
  reconcileActiveSetup(storage, (message) => void warnings.push(message))
  const owner = readOwnerPatch(storage, (message) => void warnings.push(message))
  const runtimeBundles = readBundles(storage, (message) => void warnings.push(message)).map((entry) => entry.bundle)
  await root.plugin(XinLoader, {
    baseUrl: "file:///bundle/",
    composition,
    runtime: runtimeBundles,
    owner,
    warnings,
    persist: (patch) => {
      writeOwnerPatch(storage, patch)
      writeActiveSetup(
        storage,
        readBundles(storage, () => undefined).map((entry) => entry.bundle),
        patch,
      )
    },
  })
  const loader = root.get("loader")
  if (!(loader instanceof XinLoader)) throw new Error("the loader did not start")
  root.provide("kernel", loader)
  await loader.mount()
  const broken = await loader.brokenRequired()
  const harness = root.get("harness")
  if (broken.length > 0 || harness === undefined)
    return {
      root,
      loader,
      failure: `required rows are not active (${broken.map((row) => `${row.id}: ${row.error}`).join("; ") || "no harness"})`,
    }
  await root.clock.arm(harness.wake())
  harness.resume()
  return { root, loader, failure: undefined }
}
