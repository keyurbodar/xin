import "@ui-sdk/web/dialog"
import { createEffect, For, on, Show, type JSX } from "solid-js"
import { CircleAlert, CircleCheck, MessageSquare } from "lucide-solid"
import { Spinner } from "../ui/loaders.tsx"
import { DIALOG_BACKDROP, DIALOG_CONTENT } from "../ui/dialog.tsx"
import { StatusLine } from "./controls.tsx"
import { createOverlayMount } from "../shell/presence.ts"
import { enablePush, notificationsOpen, onboardingPush, openNotifications } from "../../state/onboarding.ts"

const KINDS = [
  { icon: MessageSquare, tone: "text-needs", title: "Needs you", detail: "A question, with the choices as buttons" },
  { icon: CircleCheck, tone: "text-done", title: "Finished", detail: "When a report lands" },
  { icon: CircleAlert, tone: "text-failed", title: "Failed", detail: "With what broke and a Retry link" },
] as const

export function NotificationsDialog(): JSX.Element {
  const { mounted, settle } = createOverlayMount(notificationsOpen)
  const busy = (): boolean => onboardingPush().kind === "working"
  return (
    <Show when={mounted()}>
      <ui-dialog
        prop:open={notificationsOpen()}
        dismissible={busy() ? "false" : undefined}
        on:openchange={(event) => {
          if (event.detail.value) return
          event.preventDefault()
          queueMicrotask(() => openNotifications(false))
        }}
        on:openchangecomplete={settle}
      >
        <ui-dialog-backdrop class={DIALOG_BACKDROP} />
        <ui-dialog-content initial-focus="[data-primary]" class={`${DIALOG_CONTENT} w-[var(--w-dialog-sm)] px-6 pb-5 pt-5`}>
          <Panel />
        </ui-dialog-content>
      </ui-dialog>
    </Show>
  )
}

function Panel(): JSX.Element {
  const push = onboardingPush
  const busy = (): boolean => push().kind === "working"
  const pushOn = (): boolean => push().kind === "on"
  const close = (): void => {
    if (!busy()) openNotifications(false)
  }

  let primary!: HTMLButtonElement
  createEffect(
    on(pushOn, (isOn) => {
      if (isOn) primary.focus()
    }, { defer: true }),
  )

  const status = (): { tone: "error" | "ok" | "muted"; text: string | undefined } => {
    const outcome = push()
    switch (outcome.kind) {
      case "idle":
        return { tone: "muted", text: undefined }
      case "working":
        return { tone: "muted", text: "Waiting for the browser’s permission prompt." }
      case "on":
        return { tone: "ok", text: "Push is on for this browser." }
      case "off":
        return { tone: "error", text: outcome.message }
    }
  }

  return (
    <>
        <p class="text-sm text-ink-3">Step 5 · optional</p>
        <ui-dialog-title class="mt-1 block text-title-sm font-title">Get a nudge when a thread needs you</ui-dialog-title>
        <p class="mt-1.5 text-base text-ink-2">
          Threads keep working after you close the tab. Turn on push and Ingle only tells you about these three things.
        </p>

        <ul class="mt-4 flex flex-col border-y border-line-1 py-2">
          <For each={KINDS}>
            {(kind) => (
              <li class="flex items-center gap-3 py-2">
                <span class={`grid h-8 w-8 shrink-0 place-items-center rounded-md bg-secondary ${kind.tone}`}>
                  <kind.icon size={16} stroke-width={1.75} aria-hidden="true" />
                </span>
                <span class="min-w-0">
                  <span class="block text-base font-medium text-ink">{kind.title}</span>
                  <span class="block text-sm text-ink-3">{kind.detail}</span>
                </span>
              </li>
            )}
          </For>
        </ul>

        <div class="mt-3 min-h-0">
          <StatusLine tone={status().tone} text={status().text} />
        </div>

        <div class="mt-3 flex items-center gap-2">
          <span class="mr-auto text-sm text-ink-3">Change this any time in Settings → Notifications</span>
          <Show
            when={!pushOn()}
            fallback={
              <button
                ref={primary}
                data-primary
                type="button"
                onClick={close}
                class="im-press h-8 rounded-md bg-accent px-3 text-base font-medium text-on-accent"
              >
                Done
              </button>
            }
          >
            <button
              type="button"
              onClick={close}
              disabled={busy()}
              class="im-press im-hover h-8 shrink-0 rounded-md px-2.5 text-base text-ink-2 disabled:opacity-50"
            >
              Not now
            </button>
            <button
              ref={primary}
              data-primary
              type="button"
              disabled={busy()}
              aria-busy={busy()}
              onClick={() => void enablePush()}
              class="im-press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-base font-medium text-on-accent enabled:hover:brightness-110 disabled:opacity-60"
            >
              <Show when={busy()}>
                <Spinner size={14} />
              </Show>
              Turn on
            </button>
          </Show>
        </div>
    </>
  )
}
