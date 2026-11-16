import "../../src/styles/app.css"
import { render } from "solid-js/web"
import { trackMotion } from "../../src/lib/motion.ts"
import { SettingsScreen } from "../../src/screens/settings.tsx"

const day = (offset: number): string => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)

const state = {
  owner: { name: "Ada", instructions: "Keep replies short." },
  prefs: { waiting: true, finished: true, failed: true, spend: true, schedule: false },
  quiet: { enabled: false, start: 1320, end: 420 },
  testDelay: 20,
  fallbacks: [
    { provider: "anthropic", modelId: "claude-sonnet" },
    { provider: "openai", modelId: "gpt-mini" },
  ] as { provider: string; modelId: string }[],
  sent: [] as { op: string; args: Record<string, unknown> }[],
  rows: [
    { id: "memory", plugin: "memory", title: "Memory", required: false, disabled: false, state: { kind: "active" }, config: {} },
    { id: "outline", plugin: "outline", title: "Outline", required: false, disabled: true, state: { kind: "disabled" }, config: {} },
    { id: "host", plugin: "host", title: "Host", required: true, disabled: false, state: { kind: "active" }, config: {} },
  ],
}

const answer = (op: string, args: Record<string, unknown>): unknown => {
  switch (op) {
    case "models.list":
      return { models: MODELS, omittedModels: 0 }
    case "models.catalog":
      return {
        providers: [
          { id: "anthropic", health: { state: "ok", at: Date.now(), failures: 0 } },
          { id: "openai", health: { state: "failing", at: Date.now(), failures: 2, error: "401 invalid x-api-key" } },
        ],
        models: [],
      }
    case "credential.set":
      if (args.key === "bad") throw new Error("the key was not saved: 401 invalid x-api-key")
      return { provider: args.provider, type: "api_key", custom: false, test: { ok: true } }
    case "owner.fallbacks":
      return { models: state.fallbacks }
    case "owner.fallbacks.set": {
      const models = args.models as { provider: string; modelId: string }[]
      if (models.length > 8) throw new Error("at most 8 fallbacks")
      state.fallbacks = models
      return { models }
    }
    case "owner.read":
      return state.owner
    case "owner.set":
      Object.assign(state.owner, args)
      return state.owner
    case "owner.defaults":
      return { ok: true }
    case "notify.prefs":
      return state.prefs
    case "notify.set":
      Object.assign(state.prefs, args)
      return state.prefs
    case "notify.quiet":
      return state.quiet
    case "notify.quiet.set":
      Object.assign(state.quiet, args)
      return state.quiet
    case "push.list":
      return [{ endpoint: "https://push.example.com/a", origin: "https://ingle.example.com" }]
    case "usage.summary":
      return {
        spend: 4.2,
        tokens: 120_000,
        today: { cost: 0.4 },
        month: { cost: 4.2 },
        cap: 25,
        alert: 1,
        days: [0, 1, 2, 3].map((offset) => ({ day: day(offset), cost: 0.4 + offset * 0.3, tokens: 20_000 })),
        byModel: [{ name: "anthropic/claude-sonnet", provider: "anthropic", modelId: "claude-sonnet", cost: 3.1, totalTokens: 90_000 }],
        byTool: [{ name: "web.fetch", cost: 0.2, totalTokens: 4_000 }],
        byProject: [{ id: "p1", name: "Atlas", spend: 3.4, tokens: 100_000 }],
      }
    case "plugin.list":
      return state.rows
    case "plugin.catalog":
      return state.rows.map((row) => ({ name: row.plugin, title: row.title, description: `${row.title} plugin`, required: row.required, schema: null }))
    case "plugin.enable": {
      const row = state.rows.find((entry) => entry.id === args.id)
      if (row !== undefined) {
        row.disabled = args.enabled !== true
        row.state = { kind: row.disabled ? "disabled" : "active" }
      }
      return { ok: true }
    }
    case "plugin.packages":
      return []
    case "session.list":
      return [{ id: "s1", since: Date.now() - 60_000, origin: "https://ingle.example.com" }]
    case "memory.profile":
      return { profile_md: "Ada writes **TypeScript**." }
    case "system.version":
      return { build: "b1234", bundles: ["core"], degraded: false, rows: [] }
    case "system.metrics":
      return { uptimeMs: 3_600_000, storageBytes: 1_048_576, sockets: 1, rows: { total: 3, active: 2 }, pushDevices: 1 }
    default:
      throw new Error(`fixture has no ${op}`)
  }
}

const MODELS = [
  { provider: "anthropic", modelId: "claude-sonnet", name: "Sonnet", contextWindow: 200_000, vision: true, reasoning: true },
  { provider: "openai", modelId: "gpt-mini", name: "Mini", contextWindow: 128_000, vision: false, reasoning: false },
  ...["Opus", "Haiku", "Lyric", "Cadence"].map((name) => ({ provider: "anthropic", modelId: `fixture-${name.toLowerCase().replace(" ", "-")}`, name, contextWindow: 200_000, vision: false, reasoning: false })),
  ...["Nano", "Turbo", "Large", "Coder"].map((name) => ({ provider: "openai", modelId: `fixture-${name.toLowerCase()}`, name, contextWindow: 128_000, vision: false, reasoning: false })),
]

const tested = (provider: unknown): unknown =>
  provider === "anthropic"
    ? { ok: true, provider, model: { provider, modelId: "claude-sonnet" }, latencyMs: 412 }
    : { ok: false, provider, model: { provider, modelId: "gpt-mini" }, latencyMs: 90, error: "401 invalid x-api-key" }

const calls: string[] = []

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith("/v1/cmd")) return new Response("{}", { status: 404 })
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string; args: Record<string, unknown> }[]
  const acks = frames.map((frame) => {
    calls.push(frame.op)
    state.sent.push({ op: frame.op, args: frame.args })
    try {
      return { t: "ack", id: frame.id, ok: true, result: frame.op === "credential.test" ? tested(frame.args.provider) : answer(frame.op, frame.args) }
    } catch (problem) {
      return { t: "ack", id: frame.id, ok: false, error: { code: "bad_args", message: problem instanceof Error ? problem.message : String(problem) } }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, frames.some((frame) => frame.op === "credential.test") ? state.testDelay : 20))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

Object.assign(window, { fetch: fakeFetch, calls, state })
trackMotion()
render(
  () => (
    <main class="flex h-screen w-full bg-panel">
      <SettingsScreen />
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
