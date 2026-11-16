import { type Context, Service } from "@deepseek-ai/cordis"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels, type Models } from "@earendil-works/pi-ai"
import {
  type ConversationId,
  type CompactionSettings,
  createRegistry,
  type Cursor,
  type EnvTarget,
  type Extension,
  Harness,
  type Registry,
  type Report,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { loaderRow } from "../contributions.ts"
import { JournalStorage } from "./journal.ts"
import { hidden } from "./hidden.ts"
import type { IngleLoader } from "./loader.ts"

export type Installed = {
  readonly extension: Extension
  readonly owner: number | null
  readonly row: string | undefined
}
export type InstalledName = {
  readonly name: string
  readonly row: string | undefined
  readonly kind: "kernel" | "row"
}
type EnvProvider = (target: EnvTarget) => ExecutionEnv | undefined

/**
 * Provider retries per model request: 2, 4, 8, 16, 32 and 60 s apart (pi-ai caps one wait at 60 s), so a run rides out
 * about two minutes of rate limiting or overload before it fails. Each wait is one durable sleep commit.
 */
const PROVIDER_RETRIES = 6

const own = hidden<Pi, Context>()

const refuseHandle = async (): Promise<never> => {
  throw new Error("a tool handle names a tool for configure and cannot run")
}

export class Pi extends Service {
  static readonly inject = ["host", "clock"]

  readonly registry: Registry = createRegistry()
  readonly installed = new Map<string, Installed>()
  readonly modelSources: (() => Models)[] = []
  readonly envSources: EnvProvider[] = []
  private storage: JournalStorage | undefined
  readonly compactionSources: (() => CompactionSettings | undefined)[] = []

  constructor(ctx: Context) {
    super(ctx, "pi")
    own.set(this, ctx)
  }

  async [Service.init](): Promise<void> {
    const { state, abort } = this.ctx.host
    const storage = await JournalStorage.open(state.storage, BACKGROUND_CONTEXT)
    this.storage = storage
    const harness = await Harness.open(
      storage,
      {
        models: () => this.currentModels(),
        registry: this.registry,
        settings: () => {
          const compaction = this.compactionSources[0]?.()
          return {
            stream: { cacheRetention: "long" },
            retry: { maxRetries: PROVIDER_RETRIES },
            ...(compaction === undefined ? {} : { compaction }),
          }
        },
        env: (target) => this.envSources.map((source) => source(target)).find((env) => env !== undefined),
        onWake: (wake) => void this.ctx.clock.arm(wake).catch(() => abort("alarm write failed")),
        onReport: (report: Report) => {
          if (report.kind === "storage_failed") abort("storage failed")
        },
      },
      BACKGROUND_CONTEXT,
    )
    this.ctx.effect(() => () => harness.close(BACKGROUND_CONTEXT), "harness.close")
    this.ctx.provide("harness", harness)
  }

  /** Every conversation id, read from the in-memory storage the harness runs on, so a scan costs no row. */
  async conversations(): Promise<ConversationId[]> {
    const ids: ConversationId[] = []
    let cursor: Cursor | undefined
    do {
      const page = await this.storage?.scanConversations({}, 256, cursor, BACKGROUND_CONTEXT)
      for (const record of page?.items ?? []) ids.push(record.id)
      cursor = page?.next
    } while (cursor !== undefined)
    return ids
  }

  install(extension: Extension): () => void {
    if (extension.tools !== undefined && extension.tools.length > 0 && !extension.name.startsWith("tool-"))
      throw new Error(
        `extension ${extension.name} carries tools, so its name must start with "tool-" (for example tool-${extension.name})`,
      )
    const owner = this.ctx.fiber.uid
    const row = loaderRow(this.ctx)
    const previous = this.installed.get(extension.name)
    if (previous !== undefined && previous.owner !== owner)
      throw new Error(`extension ${extension.name} is installed by another plugin`)
    const kernel: IngleLoader | undefined = own.get(this).get("kernel")
    for (const tool of extension.tools ?? []) {
      const undeclared = kernel?.undeclared(row, "tools", tool.name)
      if (undeclared !== undefined) throw new Error(undeclared)
    }
    return this.ctx.effect(() => {
      this.registry.install(extension)
      this.installed.set(extension.name, { extension, owner, row })
      return () => {
        if (this.installed.get(extension.name)?.extension !== extension) return
        this.installed.delete(extension.name)
        this.registry.uninstall(extension)
      }
    }, `pi.install(${extension.name})`)
  }

  models(source: () => Models): () => void {
    return this.ctx.effect(() => {
      this.modelSources.push(source)
      return () => {
        this.modelSources.splice(this.modelSources.indexOf(source), 1)
      }
    }, "pi.models")
  }

  /** The owner's compaction policy, read at every use; the first registered source wins. */
  compaction(source: () => CompactionSettings | undefined): () => void {
    return this.ctx.effect(() => {
      this.compactionSources.push(source)
      return () => {
        this.compactionSources.splice(this.compactionSources.indexOf(source), 1)
      }
    }, "pi.compaction")
  }

  env(source: EnvProvider): () => void {
    return this.ctx.effect(() => {
      this.envSources.push(source)
      return () => {
        this.envSources.splice(this.envSources.indexOf(source), 1)
      }
    }, "pi.env")
  }

  /** Every installed extension's name and the row that installed it, never the extension objects themselves. */
  extensions(): readonly InstalledName[] {
    return Object.freeze(
      [...this.installed.values()].map(({ extension, row }) =>
        Object.freeze({ name: extension.name, row, kind: row === undefined ? ("kernel" as const) : ("row" as const) }),
      ),
    )
  }

  /**
   * Handles for the installed extensions with these names, for a row that reconfigures conversations, such as presets.
   * `configure` keeps only the names it is given, so a handle carries its name and nothing an extension runs.
   */
  extensionsNamed(names: readonly string[]): readonly Extension[] {
    return Object.freeze(names.flatMap((name) => (this.installed.has(name) ? [Object.freeze({ name })] : [])))
  }

  /**
   * Handles for the registered tools with these names, for a row that removes or loads tools through `configure`, such
   * as the orchestrator. `configure` keeps only names, so a handle carries its name and an `execute` that refuses.
   */
  toolsNamed(names: readonly string[]): readonly ToolRegistration[] {
    const registered = new Set(
      this.registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    )
    return Object.freeze(
      names
        .filter((name) => registered.has(name))
        .map((name): ToolRegistration =>
          Object.freeze({ name, description: "", parameters: Object.freeze({}), execute: refuseHandle }),
        ),
    )
  }

  currentModels(): Models {
    const source = this.modelSources[0]
    if (source !== undefined) return source()
    const fallback = createModels()
    for (const provider of this.ctx.host.providers) fallback.setProvider(provider)
    return fallback
  }
}
