import { type Context, Service } from "@deepseek-ai/cordis"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels, type Models } from "@earendil-works/pi-ai"
import type { Context as ChordContext } from "@earendil-works/chord"
import {
  AgentDoc,
  type ConversationId,
  type CompactionSettings,
  createRegistry,
  type Cursor,
  defineExtension,
  type DocumentReader,
  type EnvTarget,
  type Extension,
  Harness,
  type Registry,
  type Report,
  type PromptInput,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search"
import { num, obj, opt, str } from "@earendil-works/pi-schema"
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

const TOOL_SEARCH = "tool-search"
/** MCP tools come and go as servers connect, so listing them would rewrite the prompt; `tool_search` names them. */
const UNLISTED = new Set([TOOL_SEARCH, "tool-mcp"])
const SUMMARY_CHARS = 120

const summary = (description: string): string => {
  const first = description.trim().split(/\r?\n/)[0] ?? ""
  const sentence = /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first
  return sentence.length <= SUMMARY_CHARS ? sentence : `${sentence.slice(0, SUMMARY_CHARS - 1)}…`
}

/** The tools a conversation's `modelTools` removes: never listed, never loaded by search. */
async function removedTools(
  read: DocumentReader,
  conversationId: ConversationId,
  context: ChordContext,
): Promise<ReadonlySet<string>> {
  const modelTools = (await read.snapshot(AgentDoc, conversationId, context))?.modelTools
  return new Set(modelTools === undefined || Array.isArray(modelTools) ? [] : (modelTools.remove ?? []))
}

/**
 * Every deferred tool the conversation may use, loaded or not, in extension order, so the text stays the same after
 * `tool_search` loads one and the cached prompt prefix survives.
 */
const deferredIndex = async (input: PromptInput, context: ChordContext): Promise<string | undefined> => {
  const usable = new Set([...input.agent.tools, ...input.agent.deferred].map((tool) => tool.name))
  const removed = await removedTools(input.read, input.conversationId, context)
  const lines = input.agent.extensions
    .filter((extension) => !UNLISTED.has(extension.name))
    .flatMap((extension) => extension.tools ?? [])
    .filter((tool) => tool.deferred === true && usable.has(tool.name) && !removed.has(tool.name))
    .map((tool) => `- ${tool.name}: ${summary(tool.description)}`)
  if (lines.length === 0) return undefined
  return [
    "Load any of these with tool_search (its name or what you need); it is offered from your next call.",
    ...lines,
  ].join("\n")
}

/** Ranked hits a query that names no tool loads, below pi's 8 so a vague query does not load a family. */
const SEARCH_LIMIT = 3
const rankedSearch = createToolSearchTool()

type Described = { readonly name: string; readonly description: string }

const loadedResult = (tools: readonly Described[]) => {
  const loaded = tools.map((tool) => tool.name)
  if (loaded.length === 0)
    return { output: [{ type: "text" as const, text: "No matching tools found." }], details: { loaded } }
  return {
    output: [
      {
        type: "text" as const,
        text: [
          `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:`,
          ...tools.map((tool) => `- ${tool.name}: ${summary(tool.description)}`),
        ].join("\n"),
      },
    ],
    details: { loaded },
    control: { addTools: loaded },
  }
}

/**
 * pi's `tool_search`, except that a query naming deferred tools (the index's names, separated by spaces or commas)
 * loads exactly those, a ranked search loads at most `SEARCH_LIMIT`, and a removed tool is never ranked or loaded.
 */
const searchTool: typeof rankedSearch = {
  ...rankedSearch,
  parameters: obj(
    {
      query: str({ description: "What you need, or the exact names of the tools to load." }),
      limit: opt(num({ description: `Most tools to load, ${SEARCH_LIMIT} by default and at most.` })),
    },
    { open: true },
  ),
  execute: async (args, api, context) => {
    const removed = await removedTools(api, api.conversationId, context)
    const deferred = (await api.agent(context)).deferred.filter((tool) => !removed.has(tool.name))
    const words = args.query.split(/[\s,]+/).filter((word) => word !== "")
    const named = deferred.filter((tool) => words.includes(tool.name))
    if (named.length > 0 && named.length === words.length) return loadedResult(named)
    const limit = Math.max(1, Math.min(Math.trunc(args.limit ?? SEARCH_LIMIT), SEARCH_LIMIT))
    const ranked = await rankedSearch.execute({ query: args.query, limit: limit + removed.size }, api, context)
    const names = (ranked.control?.addTools ?? []).filter((name) => !removed.has(name)).slice(0, limit)
    return loadedResult(names.flatMap((name) => deferred.filter((tool) => tool.name === name)))
  },
}

const toolSearch = defineExtension({
  name: TOOL_SEARCH,
  tools: [searchTool],
  sections: [section("deferred-tools", deferredIndex)],
})

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
      this.offerSearch()
      return () => {
        if (this.installed.get(extension.name)?.extension !== extension) return
        this.installed.delete(extension.name)
        this.registry.uninstall(extension)
        this.offerSearch()
      }
    }, `pi.install(${extension.name})`)
  }

  /**
   * `tool_search` is offered only while some extension carries a deferred tool; with none it could only say "no match".
   * It is listed as a kernel extension, so presets keep it and see the registry they compare against.
   */
  private offerSearch(): void {
    const wanted = [...this.installed.values()].some(({ extension }) =>
      (extension.tools ?? []).some((tool) => tool.deferred === true),
    )
    if (wanted === this.installed.has(TOOL_SEARCH)) return
    if (wanted) {
      this.registry.install(toolSearch)
      this.installed.set(TOOL_SEARCH, { extension: toolSearch, owner: null, row: undefined })
      return
    }
    this.installed.delete(TOOL_SEARCH)
    this.registry.uninstall(toolSearch)
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
