import { ErrorBoundary, For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { host, rendererFor, slotItems } from "./registry.ts"
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

/** Contains a plugin component that throws while rendering, so it shows a line in its place instead of blanking the app. */
export function PluginBoundary(props: { plugin: string; children: JSX.Element }): JSX.Element {
  return (
    <ErrorBoundary
      fallback={(error: unknown) => {
        console.error(`plugin ${props.plugin} failed to render`, error)
        return <p class="px-2 py-1.5 text-sm text-ink-3">{props.plugin} failed to render</p>
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}

export function SlotList(props: { slot: "sidebar.section" | "settings.page" }): JSX.Element {
  const items = slotItems(props.slot)
  return (
    <For each={items()}>
      {(item) => (
        <section class="flex flex-col">
          <span class="label px-2 pb-1.5 pt-4">{item.title}</span>
          <PluginBoundary plugin={item.plugin}>
            <Dynamic component={item.component} host={host} />
          </PluginBoundary>
        </section>
      )}
    </For>
  )
}

export function ToolRenderer(props: { call: RenderedCall; class?: string }): JSX.Element {
  return (
    <Show when={rendererFor(props.call.name)}>
      {(renderer) => (
        <div class={props.class}>
          <PluginBoundary plugin={renderer().plugin}>
            <Dynamic component={renderer().component} host={host} call={props.call} />
          </PluginBoundary>
        </div>
      )}
    </Show>
  )
}
