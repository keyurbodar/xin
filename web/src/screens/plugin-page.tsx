import type { Component, JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { PluginBoundary } from "../plugins/boundary.tsx"
import type { Host } from "../plugins/sdk.ts"

/** A plugin's Settings page under its title, contained so a page that throws leaves the rest of Settings standing. */
export function PluginPage(props: {
  plugin: string
  title: string
  component: Component<{ host: Host }>
  host: Host
}): JSX.Element {
  return (
    <>
      <h1 class="text-xl font-semibold tracking-[-0.015em] text-ink">{props.title}</h1>
      <div class="mt-7">
        <PluginBoundary plugin={props.plugin}>
          <Dynamic component={props.component} host={props.host} />
        </PluginBoundary>
      </div>
    </>
  )
}
