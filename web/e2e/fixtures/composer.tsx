import "../../src/styles/app.css"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Composer } from "../../src/components/chat/composer.tsx"
import type { ThinkingLevel } from "../../src/lib/thinking.ts"
import type { Streams } from "../../src/lib/api.ts"
import { subscribeHome, type ProjectSummary, type ThreadSummary } from "../../src/state/home.ts"
import type { ModelInfo } from "../../src/state/settings.ts"

const REPLIES: Readonly<Record<string, unknown>> = {
  "skill.list": [
    { name: "issues", description: "File, word, move and close issues" },
    { name: "make-a-deck", description: "Build a slide deck as one HTML file" },
    { name: "plan", description: "Explore first, then write a plan" },
  ],
  "prompt.list": [
    { name: "fix", description: "Fix the failing test", text: "Fix the failing test." },
    { name: "ship", description: "Ship the change", text: "Ship the change." },
  ],
  "file.list": [{ path: "/projects/ingle/notes.md" }, { path: "/projects/ingle/docs/spec.md" }],
  "conv.context": {
    conversation: 1,
    contextWindow: 200_000,
    used: 48_000,
    compactAt: 160_000,
    measured: true,
    categories: [
      { key: "system", tokens: 6_000 },
      { key: "tools", tokens: 12_000 },
      { key: "conversation", tokens: 30_000 },
    ],
  },
}

const realFetch = window.fetch.bind(window)
async function stub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (String(input) !== "/v1/cmd") return realFetch(input, init)
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string }[]
  const empty = new URLSearchParams(location.search).get("empty")
  const acks = frames.map((frame) => ({ id: frame.id, ok: true, result: frame.op === empty ? [] : (REPLIES[frame.op] ?? []) }))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}
Object.defineProperty(window, "fetch", { value: stub })

const enabledPlugin = new URLSearchParams(location.search).get("plugin")
if (enabledPlugin !== null) {
  const streams = {
    subscribe: (_stream: string, subscription: { value: (value: unknown, rev: string) => void }) => {
      subscription.value({ plugins: { [enabledPlugin]: "active" } }, "1")
      return () => undefined
    },
  }
  subscribeHome(streams as unknown as Streams)
}

const thread = (id: number, title: string, status: string): ThreadSummary => ({ id, title, status, run: 1 })
const project: ProjectSummary = {
  id: "p1",
  slug: "ingle",
  name: "Ingle",
  archived: false,
  coordinatorId: 1,
  openRequests: 0,
  requestsRev: 0,
  spaces: [],
  threads: {
    working: [thread(11, "Port the dialog shell", "working")],
    waiting: [thread(12, "Review the spec", "waiting")],
    completed: [],
    failed: [],
    cancelled: [],
  },
}

const model = (provider: string, modelId: string, name: string, keyed = true): ModelInfo => ({
  provider,
  modelId,
  name,
  contextWindow: 200_000,
  vision: true,
  reasoning: true,
  thinking: ["off", "low", "medium", "high"],
  keyed,
  cost: undefined,
})
const CATALOG = [
  model("anthropic", "opus", "Opus Test"),
  model("anthropic", "sonnet", "Sonnet Test"),
  model("openai", "gpt", "GPT Test"),
  model("openai", "mini", "Mini Test", false),
]
const LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"]

function App(): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [current, setCurrent] = createSignal<ModelInfo | undefined>(CATALOG[0])
  const [effort, setEffort] = createSignal<ThinkingLevel | undefined>("medium")
  const [busy, setBusy] = createSignal(false)
  const [sent, setSent] = createSignal("")
  const [sends, setSends] = createSignal<readonly string[]>([])
  const models = (): readonly ModelInfo[] =>
    CATALOG.filter((entry) => entry.name.toLowerCase().includes(query().trim().toLowerCase()))

  return (
    <main class="flex min-h-screen flex-col justify-end bg-bg pb-6">
      <Composer
        project={project}
        active
        modelLabel={current()?.name ?? "Model"}
        model={current()}
        models={models()}
        omitted={0}
        query={query()}
        onSearch={setQuery}
        busy={busy()}
        fresh={new URLSearchParams(location.search).get("fresh") !== "0"}
        presets={[]}
        presetId={undefined}
        presetLocked={false}
        effort={effort()}
        efforts={LEVELS}
        onPickModel={async (model) => {
          setCurrent(model)
        }}
        onPickPreset={async () => undefined}
        onPickEffort={async (level) => {
          setEffort(level)
        }}
        onSend={async (text, _key, attachments) => {
          setSent(text)
          setSends([...sends(), `${text}+${attachments.length}`])
          setBusy(true)
        }}
        onStop={async () => {
          setBusy(false)
        }}
        onAttach={async (file) => ({ path: `/projects/ingle/attachments/${file.name}`, name: file.name, size: file.size, type: file.type })}
      />
      <output id="sent" class="sr-only">{sent()}</output>
      <output id="sends" class="sr-only">{JSON.stringify(sends())}</output>
      <output id="effort" class="sr-only">{effort() ?? ""}</output>
      <output id="model" class="sr-only">{current()?.modelId ?? ""}</output>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
