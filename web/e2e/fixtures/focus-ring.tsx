import "../../src/styles/app.css"
import "@ui-sdk/web/input"
import { For } from "solid-js"
import { render } from "solid-js/web"
import { EnabledToggle, RowMenu } from "../../src/components/automations/parts.tsx"
import { ICON_BUTTON } from "../../src/components/shell/menu.ts"
import { FIELD_INPUT } from "../../src/components/ui/dialog.tsx"
import type { Automation } from "../../src/lib/automations.ts"

const theme = new URLSearchParams(location.search).get("theme")
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

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
