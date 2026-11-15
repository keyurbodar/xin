import { For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { host, rendererFor, slotItems, toastList } from "./registry.ts"
import type { RenderedCall } from "./sdk.ts"

export {
  activeConversation,
  applyTheme,
  bindComposer,
  bindConversation,
  host,
  rendererFor,
  slotItems,
  themes,
  type SlotItem,
} from "./registry.ts"

export function SlotList(props: { slot: "sidebar.section" | "settings.page" }): JSX.Element {
  const items = slotItems(props.slot)
  return (
    <For each={items()}>
      {(item) => (
        <section class="flex flex-col">
          <span class="label px-2 pb-1.5 pt-4">{item.title}</span>
          <Dynamic component={item.component} host={host} />
        </section>
      )}
    </For>
  )
}

export function ToolRenderer(props: { call: RenderedCall; class?: string }): JSX.Element {
  return (
    <Show when={rendererFor(props.call.name)}>
      {(component) => (
        <div class={props.class}>
          <Dynamic component={component()} host={host} call={props.call} />
        </div>
      )}
    </Show>
  )
}

export function Toasts(): JSX.Element {
  return (
    <div class="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <For each={toastList()}>
        {(toast) => (
          <div class="enter rounded-md bg-popover px-3 py-2 text-sm text-ink shadow-overlay">
            {toast.text}
          </div>
        )}
      </For>
    </div>
  )
}
