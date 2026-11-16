import "@ui-sdk/web/dialog"
import { Show, createEffect, type Accessor, type JSX } from "solid-js"
import { createOverlayMount } from "../shell/presence.ts"
import { Icon } from "./icon.tsx"

export const DIALOG_BACKDROP = "im-scrim fixed inset-0 bg-scrim"

export const DIALOG_CONTENT =
  "im-dialog fixed inset-0 m-auto h-fit max-h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg bg-card p-0 text-ink shadow-overlay"

/** A dialog keeps its state between openings, so the fields reset when it opens again. */
export function resetOnOpen(open: Accessor<boolean>, reset: () => void): void {
  let wasOpen = false
  createEffect(() => {
    const current = open()
    if (current && !wasOpen) reset()
    wasOpen = current
  })
}

/** V3: one dialog shell on ui-sdk's Dialog: it fades and scales in from .96 over 200 (`im-dialog`), leaves in 140, traps focus, and closes on Escape or the scrim. */
export function Dialog(props: {
  open: boolean
  onClose: () => void
  title: string
  busy?: boolean
  width?: string
  footer?: JSX.Element
  onSubmit?: (() => void) | undefined
  returnFocus?: HTMLElement | undefined
  children: JSX.Element
}): JSX.Element {
  const { mounted, settle } = createOverlayMount(() => props.open)
  return (
    <Show when={mounted()}>
      <ui-dialog
        prop:open={props.open}
        dismissible={props.busy === true ? "false" : undefined}
        on:openchange={(event) => {
          if (event.detail.value) return
          event.preventDefault()
          queueMicrotask(props.onClose)
        }}
        on:openchangecomplete={(event) => {
          if (!event.detail.value && props.returnFocus?.isConnected === true) props.returnFocus.focus()
          settle(event)
        }}
      >
        <ui-dialog-backdrop class={DIALOG_BACKDROP} />
        <ui-dialog-content
          initial-focus="[autofocus], input, textarea"
         
          class={`${DIALOG_CONTENT} ${props.width ?? "w-[var(--w-dialog-lg)]"}`}
        >
          <form
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
              event.preventDefault()
              props.onSubmit?.()
            }}
            onSubmit={(event) => {
              event.preventDefault()
              props.onSubmit?.()
            }}
          >
            <div class="flex h-[var(--h-header)] items-center border-b border-line-1 pl-6 pr-3">
              <ui-dialog-title class="text-title-mini font-title">{props.title}</ui-dialog-title>
              <button
                type="button"
                onClick={props.onClose}
                aria-label="Close"
                disabled={props.busy}
                class="im-press im-hover ml-auto grid h-[var(--h-control)] w-[var(--h-control)] place-items-center rounded-sm text-ink-3 hover:bg-secondary hover:text-ink disabled:opacity-50"
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            <div class="flex flex-col gap-4 p-6">{props.children}</div>

            <Show when={props.footer}>
              {(footer) => <div class="flex h-14 items-center gap-2 border-t border-line-1 px-6">{footer()}</div>}
            </Show>
          </form>
        </ui-dialog-content>
      </ui-dialog>
    </Show>
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
        <span class="text-sm font-medium text-ink-2">{props.label}</span>
        <Show when={props.optional === true}>
          <span class="text-sm text-icon">optional</span>
        </Show>
      </span>
      {props.children}
      <Show when={props.hint !== undefined}>
        <span class="text-xs text-ink-3">{props.hint}</span>
      </Show>
    </label>
  )
}

export const FIELD_INPUT =
  "w-full rounded-sm border border-line-2 bg-panel px-2.5 text-base text-ink outline-none placeholder:text-icon focus:border-primary/40 focus:ring-[3px] focus:ring-primary-soft disabled:opacity-50"
