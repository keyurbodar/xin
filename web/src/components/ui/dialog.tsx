import { Show, createEffect, onCleanup, onMount, type Accessor, type JSX } from "solid-js"
import { createPresence } from "../shell/presence.ts"
import { Icon } from "./icon.tsx"

/** A dialog keeps its state between openings, so the fields reset when it opens again. */
export function resetOnOpen(open: Accessor<boolean>, reset: () => void): void {
  let wasOpen = false
  createEffect(() => {
    const current = open()
    if (current && !wasOpen) reset()
    wasOpen = current
  })
}

/** V3: one dialog shell. It fades and scales in over 200, leaves in 140, traps focus, and closes on Escape or the scrim. */
export function Dialog(props: {
  open: boolean
  onClose: () => void
  title: string
  busy?: boolean
  width?: string
  footer?: JSX.Element
  onSubmit?: (() => void) | undefined
  children: JSX.Element
}): JSX.Element {
  const { mounted, leaving } = createPresence(() => props.open, 140)
  return (
    <Show when={mounted()}>
      <Frame
        closing={leaving()}
        title={props.title}
        busy={props.busy === true}
        width={props.width ?? "w-[640px]"}
        footer={props.footer}
        onSubmit={props.onSubmit}
        onClose={props.onClose}
      >
        {props.children}
      </Frame>
    </Show>
  )
}

function Frame(props: {
  closing: boolean
  title: string
  busy: boolean
  width: string
  footer: JSX.Element | undefined
  onSubmit: (() => void) | undefined
  onClose: () => void
  children: JSX.Element
}): JSX.Element {
  let panel!: HTMLFormElement

  const focusables = (): readonly HTMLElement[] => [
    ...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ]

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      if (!props.busy) props.onClose()
      return
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      props.onSubmit?.()
      return
    }
    if (event.key !== "Tab") return
    const items = focusables()
    const first = items[0]
    const last = items[items.length - 1]
    if (first === undefined || last === undefined) return
    const active = document.activeElement
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault()
        last.focus()
      }
      return
    }
    if (active === last || !panel.contains(active)) {
      event.preventDefault()
      first.focus()
    }
  }

  onMount(() => {
    const first = panel.querySelector<HTMLElement>("[autofocus], input, textarea")
    first?.focus()
    document.addEventListener("keydown", onKey)
  })
  onCleanup(() => document.removeEventListener("keydown", onKey))

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 transition-opacity duration-[140ms]"
      classList={{ "opacity-0": props.closing }}
      onMouseDown={() => {
        if (!props.busy) props.onClose()
      }}
    >
      <form
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        class={`relative max-h-[calc(100vh-32px)] ${props.width} max-w-[calc(100vw-32px)] overflow-y-auto rounded-[4px] border border-line-inner bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.65)]`}
        classList={{ enter: !props.closing, "dialog-out": props.closing }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit?.()
        }}
      >
        <div class="flex items-center border-b border-line px-5 py-3.5">
          <h2 class="text-[15px] font-medium">{props.title}</h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            disabled={props.busy}
            class="ml-auto grid h-7 w-7 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div class="flex flex-col gap-4 px-5 py-4">{props.children}</div>

        <Show when={props.footer}>
          {(footer) => <div class="flex items-center gap-2 border-t border-line px-5 py-3">{footer()}</div>}
        </Show>
      </form>
    </div>
  )
}

export function Field(props: {
  label: string
  optional?: boolean
  hint?: string
  children: JSX.Element
}): JSX.Element {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="flex items-baseline gap-1.5">
        <span class="text-[12px] font-medium text-fg-2">{props.label}</span>
        <Show when={props.optional === true}>
          <span class="text-[12px] text-fg-4">optional</span>
        </Show>
      </span>
      {props.children}
      <Show when={props.hint !== undefined}>
        <span class="text-[11.5px] text-fg-3">{props.hint}</span>
      </Show>
    </label>
  )
}

export const FIELD_INPUT =
  "w-full rounded-[2px] border border-line-inner bg-surface px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-4 focus:border-accent-line focus:ring-[3px] focus:ring-accent-dim disabled:opacity-50"
