import type { JSX } from "solid-js"

export function Spinner(props: { size?: 12 | 14 | 16 | 20 | 32; class?: string; label?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={props.size ?? 16}
      height={props.size ?? 16}
      class={`im-spinner ${props.class ?? ""}`}
      role="img"
      aria-label={props.label ?? "Loading"}
    >
      <circle cx="8" cy="8" r="6" opacity="0.22" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  )
}

export function BootLoader(props: { label: string }): JSX.Element {
  return (
    <div class="im-boot flex flex-col items-center gap-4" role="status">
      <svg viewBox="0 0 96 96" width={96} height={96} aria-hidden="true">
        <path class="im-boot-guide" d="M4 48h88M48 4v88" />
        <path class="im-boot-shape" pathLength="1" d="M24 24h48v48H24Z" />
        <path class="im-boot-shape" pathLength="1" d="M48 24a24 24 0 1 1 0 48a24 24 0 1 1 0-48" />
        <path class="im-boot-shape" pathLength="1" d="M48 24 72 72H24Z" />
        <path class="im-boot-pen" d="M-3 0h6M0-3v6" />
        <g class="im-boot-orbit">
          <path class="im-boot-pen" d="M45 24h6M48 21v6" />
        </g>
      </svg>
      <span class="font-mono text-xs text-ink-3">{props.label}</span>
    </div>
  )
}

export function Thinking(props: { children: JSX.Element }): JSX.Element {
  return (
    <span class="inline-flex items-center gap-2 text-ink-3">
      <span class="im-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {props.children}
    </span>
  )
}
