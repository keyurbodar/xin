import "../../src/styles/app.css"
import "@ui-sdk/web/input"
import { For, Show } from "solid-js"
import { render } from "solid-js/web"
import { EnabledToggle, RowMenu } from "../../src/components/automations/parts.tsx"
import { SearchBox } from "../../src/components/explore/parts.tsx"
import { ProviderStep } from "../../src/components/onboarding/provider-step.tsx"
import { Section } from "../../src/components/pane/overview.tsx"
import { ConversationTabs } from "../../src/components/shell/conversation-tabs.tsx"
import { ICON_BUTTON } from "../../src/components/shell/menu.ts"
import { FIELD_INPUT } from "../../src/components/ui/dialog.tsx"
import type { Automation } from "../../src/lib/automations.ts"
import type { ProjectSummary, ThreadSummary } from "../../src/state/home.ts"

const params = new URLSearchParams(location.search)
const theme = params.get("theme")
if (theme !== null) document.documentElement.dataset.theme = theme

const automation: Automation = {
  id: "a1",
  title: "Weekly review",
  prompt: "Review the week.",
  project: null,
  target: "fresh",
  threadId: null,
  enabled: true,
  updatedAt: new Date().toISOString(),
  nextAt: null,
  triggers: [],
  lastRun: null,
}

const SURFACES = [
  { name: "background", class: "bg-bg" },
  { name: "panel", class: "bg-panel" },
  { name: "raised", class: "bg-card" },
  { name: "overlay", class: "bg-popover" },
  { name: "hover", class: "bg-card", inner: "bg-hover" },
  { name: "selected", class: "bg-card", inner: "bg-secondary" },
] as const

const thread = (id: number): ThreadSummary => ({ id, title: `Thread number ${id}`, status: "completed", run: 1 })
const threads = [21, 22, 23, 24, 25, 26].map(thread)
const project: ProjectSummary = {
  id: "p1",
  slug: "ingle",
  name: "Ingle",
  archived: false,
  coordinatorId: 1,
  openRequests: 0,
  requestsRev: 0,
  spaces: [],
  threads: { working: [], waiting: [], completed: threads, failed: [], cancelled: [] },
}

function Cases() {
  return (
    <main class="flex flex-col gap-6 bg-bg p-4">
      <div data-case="tab" class="w-[360px] overflow-hidden bg-panel">
        <ConversationTabs
          project={project}
          base="/p/ingle"
          mark={<span>I</span>}
          threads={threads}
          activeThreadId={21}
          cost={undefined}
          actions={[]}
          onAction={() => undefined}
        />
      </div>
      <div data-case="search" class="bg-panel p-4">
        <SearchBox value="" placeholder="Search plugins" onInput={() => undefined} />
      </div>
      <div data-case="section" class="w-[360px] bg-panel p-2">
        <Section label="Threads" count={2}>
          <p class="px-2 text-sm">Body</p>
        </Section>
      </div>
      <div data-case="card" class="w-[420px] bg-panel p-4">
        <ProviderStep />
      </div>
      <div data-case="menu" class="flex justify-end bg-card p-4">
        <RowMenu automation={automation} enabled busy={false} onAction={() => undefined} />
      </div>
    </main>
  )
}

function App() {
  return (
    <main class="flex flex-col gap-2 bg-bg p-4">
      <For each={SURFACES}>
        {(surface) => (
          <div class={surface.class}>
            <div data-surface={surface.name} class={`flex items-center gap-4 p-4 ${"inner" in surface ? surface.inner : ""}`}>
              <button type="button" data-control="button" class={ICON_BUTTON} aria-label="Add">
                +
              </button>
              <span data-control="menu" class="contents">
                <RowMenu automation={automation} enabled busy={false} onAction={() => undefined} />
              </span>
              <ui-input class="flex w-48">
                <input data-control="input" aria-label="Name" class={`${FIELD_INPUT} h-8`} />
              </ui-input>
              <span data-control="switch" class="contents">
                <EnabledToggle automation={automation} on busy={false} onToggle={() => undefined} />
              </span>
            </div>
          </div>
        )}
      </For>
    </main>
  )
}

render(() => (
  <Show when={params.has("cases")} fallback={<App />}>
    <Cases />
  </Show>
), document.getElementById("app")!)
document.body.dataset.ready = "1"
