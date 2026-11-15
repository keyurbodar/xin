import { Match, Switch, type JSX } from "solid-js"

export type MorphKind = "send" | "copy" | "chevron" | "plus" | "reveal" | "pause"

/** `on` is the second state: stop, done, expanded, close, hidden, paused. */
export function MorphIcon(props: { kind: MorphKind; on: boolean; size?: number; class?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={`im-morph ${props.class ?? ""}`}
      data-kind={props.kind}
      data-on={props.on ? "" : undefined}
      aria-hidden="true"
    >
      <Switch>
        <Match when={props.kind === "send"}>
          <path data-part="out" d="M12 19V5M5 12l7-7 7 7" />
          <rect data-part="in" x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
        </Match>
        <Match when={props.kind === "copy"}>
          <g data-part="out">
            <rect x="8" y="8" width="13" height="13" rx="2" />
            <path d="M5 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2" />
          </g>
          <path data-draw pathLength="1" d="m5 12.5 4.5 4.5L19 7.5" />
        </Match>
        <Match when={props.kind === "chevron"}>
          <path data-part="turn" d="m6 9 6 6 6-6" />
        </Match>
        <Match when={props.kind === "plus"}>
          <path data-part="turn" d="M12 5v14M5 12h14" />
        </Match>
        <Match when={props.kind === "reveal"}>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.5" />
          <path data-draw pathLength="1" d="m4 4 16 16" />
        </Match>
        <Match when={props.kind === "pause"}>
          <path data-part="out" d="M9 6v12M15 6v12" />
          <path data-part="in" d="M8 5.5v13l10.5-6.5Z" />
        </Match>
      </Switch>
    </svg>
  )
}
