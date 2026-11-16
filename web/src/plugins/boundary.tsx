import type { JSX } from "solid-js"
import { contain } from "./isolate.ts"

/** Contains a plugin component that throws, so it shows a line in its place instead of blanking the screen. */
export function PluginBoundary(props: { plugin: string; children: JSX.Element }): JSX.Element {
  return contain(
    props.plugin,
    () => props.children,
    () => <p class="px-2 py-1.5 text-sm text-ink-3">{props.plugin} failed to render</p>,
  )
}
