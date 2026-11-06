import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis"
import { Loader } from "@deepseek-ai/cordis-plugin-loader"
import { applyPatches, compose, departures, type Patch, type Profile, type Row } from "./layers.ts"
import { parseOwnerPatch } from "./patch.ts"
import type { Runtime } from "./types.ts"

export type CatalogEntry = {
  readonly plugin: Plugin
  readonly title: string
  readonly description: string
  readonly required?: boolean
  readonly multiple?: boolean
  readonly source: string
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
}

export type XinLoaderConfig = {
  readonly baseUrl: string
  readonly composition: Composition
  readonly owner: readonly Patch[]
  readonly warnings: readonly string[]
  persist(patch: readonly Patch[]): void
}

const CORDIS_FIBER_ACTIVE = 2
const CORDIS_FIBER_FAILED = 3
const OWNER_PATCH = "plugins.patch"
const PREFIX = "cordis:"

export const pluginOf = (row: Row): string => (row.name.startsWith(PREFIX) ? row.name.slice(PREFIX.length) : row.name)

const failure = async (fiber: Fiber): Promise<string> =>
  fiber.await().then(
    () => "failed to start",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

export class XinLoader extends Loader {
  override internal = undefined
  readonly composition: Composition
  readonly lower: readonly Row[]
  readonly warnings: string[]
  private readonly initial: readonly Row[]
  private readonly persistPatch: (patch: readonly Patch[]) => void
  private missing: Row[]
  private unresolved: readonly Patch[]
  private mounted = false

  constructor(ctx: Context, config: XinLoaderConfig) {
    super(ctx, { baseUrl: config.baseUrl })
    this.composition = config.composition
    this.warnings = [...config.warnings]
    const warn = (message: string) => void this.warnings.push(message)
    for (const [name, entry] of Object.entries(config.composition.catalog)) this.builtins[name] = entry.plugin
    this.lower = compose(config.composition.bundles, config.composition.profile, warn)
    const applied = applyPatches(this.lower, config.owner, warn)
    this.initial = applied.rows
    this.unresolved = applied.unresolved
    this.missing = applied.rows.filter((row) => !this.has(row))
    this.persistPatch = config.persist
  }

  has(row: Row): boolean {
    return this.composition.catalog[pluginOf(row)] !== undefined
  }

  override commit(): void {
    if (!this.mounted) return
    this.persistPatch(this.ownerPatch())
    this.ctx.emit("plugins/changed")
  }

  rows(): readonly Row[] {
    return [...this.root.data, ...this.missing]
  }

  ownerPatch(): Patch[] {
    return [...departures(this.lower, this.rows()), ...this.unresolved]
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

  async mount(): Promise<void> {
    for (const row of this.initial) if (this.has(row)) await this.create(row)
    await this.await()
    this.mounted = true
  }
}

export function readOwnerPatch(storage: DurableObjectStorage, warn: (message: string) => void): Patch[] {
  return parseOwnerPatch(storage.kv.get(OWNER_PATCH), warn)
}

export function writeOwnerPatch(storage: DurableObjectStorage, patch: readonly Patch[]): void {
  if (patch.length === 0) storage.kv.delete(OWNER_PATCH)
  else storage.kv.put(OWNER_PATCH, patch)
}

export type Kernel = {
  readonly root: Context
  readonly loader: XinLoader
  readonly failure: string | undefined
}

async function brokenRequired(loader: XinLoader): Promise<string[]> {
  const broken: string[] = []
  for (const row of loader.rows()) {
    if (!loader.required(row.id)) continue
    const state = await loader.state(row.id)
    if (state.kind !== "active") broken.push(`${row.id}: ${state.kind === "failed" ? state.error : state.kind}`)
  }
  return broken
}

export async function boot(runtime: Runtime, composition: Composition): Promise<Kernel> {
  const root = new Context()
  root.provide("host", runtime)
  const storage = runtime.state.storage
  const warnings: string[] = []
  const owner = readOwnerPatch(storage, (message) => void warnings.push(message))
  await root.plugin(XinLoader, {
    baseUrl: "file:///bundle/",
    composition,
    owner,
    warnings,
    persist: (patch) => writeOwnerPatch(storage, patch),
  })
  const loader = root.get("loader")
  if (!(loader instanceof XinLoader)) throw new Error("the loader did not start")
  root.provide("kernel", loader)
  await loader.mount()
  const broken = await brokenRequired(loader)
  const harness = root.get("harness")
  if (broken.length > 0 || harness === undefined)
    return { root, loader, failure: `required rows are not active (${broken.join("; ") || "no harness"})` }
  await root.clock.arm(harness.wake())
  harness.resume()
  return { root, loader, failure: undefined }
}
