import "../../src/styles/app.css"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { ComposerCard } from "../../src/components/composer/composer-card.tsx"
import { ContextMeter } from "../../src/components/composer/context-meter.tsx"
import { ComposerEditor, type EditorHandle } from "../../src/components/composer/editor.tsx"
import { ModelPicker } from "../../src/components/composer/model-picker.tsx"
import { PlusMenu } from "../../src/components/composer/plus-menu.tsx"
import { ReasoningMenu } from "../../src/components/composer/reasoning-menu.tsx"
import { ScopeChips } from "../../src/components/composer/scope-chips.tsx"
import { SendButton } from "../../src/components/composer/send-button.tsx"
import { createSources } from "../../src/components/composer/sources.ts"
import type { ThinkingLevel } from "../../src/lib/thinking.ts"
import type { ProjectSummary, ThreadSummary } from "../../src/state/home.ts"
import type { ModelInfo } from "../../src/state/settings.ts"

const REPLIES: Readonly<Record<string, unknown>> = {
  "skill.list": [
    { name: "issues", description: "File, word, move and close issues" },
    { name: "make-a-deck", description: "Build a slide deck as one HTML file" },
    { name: "plan", description: "Explore first, then write a plan" },
  ],
  "prompt.list": [{ name: "fix", description: "Fix the failing test", text: "Fix the failing test." }],
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
  const acks = frames.map((frame) => ({ id: frame.id, ok: true, result: REPLIES[frame.op] ?? [] }))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}
Object.defineProperty(window, "fetch", { value: stub })

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
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [sent, setSent] = createSignal("")
  const sources = createSources(() => project)
  const models = (): readonly ModelInfo[] =>
    CATALOG.filter((entry) => entry.name.toLowerCase().includes(query().trim().toLowerCase()))
  let editor!: EditorHandle

  const ready = (): boolean => draft().trim() !== ""
  const submit = (): void => {
    if (!ready()) return
    setSent(editor.text().trim())
    editor.clear()
    setBusy(true)
  }

  return (
    <main class="flex min-h-screen flex-col justify-end bg-bg p-6 pb-10">
      <ComposerCard
        above={<ScopeChips project={project.name} device={{ name: "build", online: true }} />}
        start={
          <>
            <PlusMenu
              project={project}
              disabled={false}
              onUpload={() => setSent("upload")}
              onInsert={(_text, token) => editor.insert(token)}
              onPrompt={(_name, token) => editor.insert(token)}
            />
            <ModelPicker
              label={current()?.name ?? "Model"}
              current={current()}
              models={models()}
              omitted={0}
              query={query()}
              onSearch={setQuery}
              onPick={setCurrent}
            />
            <ReasoningMenu levels={LEVELS} level={effort()} presets={[]} presetId={undefined} presetLocked={false} onLevel={setEffort} onPreset={() => undefined} />
          </>
        }
        end={
          <>
            <ContextMeter conversation={project.coordinatorId} busy={busy()} />
            <SendButton stop={busy() && !ready()} ready={ready()} pending={false} label="Send message" onStop={() => setBusy(false)} />
          </>
        }
        onSubmit={submit}
      >
        <ComposerEditor
          sources={sources}
          label={`Message ${project.name}`}
          placeholder="Ask anything, / for commands, @ for context"
          disabled={false}
          onChange={setDraft}
          ref={(handle) => (editor = handle)}
        />
      </ComposerCard>
      <output id="sent" class="sr-only">{sent()}</output>
      <output id="effort" class="sr-only">{effort() ?? ""}</output>
      <output id="model" class="sr-only">{current()?.modelId ?? ""}</output>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
