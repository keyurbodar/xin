import { type Context, Service } from "@deepseek-ai/cordis"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels, type Models } from "@earendil-works/pi-ai"
import {
  createRegistry,
  type EnvTarget,
  type Extension,
  Harness,
  type Registry,
  type Report,
} from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { loaderRow } from "../contributions.ts"
import { JournalStorage } from "./journal.ts"

export type Installed = {
  readonly extension: Extension
  readonly owner: number | null
  readonly row: string | undefined
}
type EnvProvider = (target: EnvTarget) => ExecutionEnv | undefined

export class Pi extends Service {
  static readonly inject = ["host", "clock"]

  readonly registry: Registry = createRegistry()
  readonly installed = new Map<string, Installed>()
  readonly modelSources: (() => Models)[] = []
  readonly envSources: EnvProvider[] = []

  constructor(ctx: Context) {
    super(ctx, "pi")
  }

  async [Service.init](): Promise<void> {
    const { state, abort } = this.ctx.host
    const harness = await Harness.open(
      await JournalStorage.open(state.storage, BACKGROUND_CONTEXT),
      {
        models: () => this.currentModels(),
        registry: this.registry,
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

  env(source: EnvProvider): () => void {
    return this.ctx.effect(() => {
      this.envSources.push(source)
      return () => {
        this.envSources.splice(this.envSources.indexOf(source), 1)
      }
    }, "pi.env")
  }

  currentModels(): Models {
    const source = this.modelSources[0]
    if (source !== undefined) return source()
    const fallback = createModels()
    for (const provider of this.ctx.host.providers) fallback.setProvider(provider)
    return fallback
  }
}
