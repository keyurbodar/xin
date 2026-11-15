import { createEffect, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { CircleAlert, CircleCheck, MessageSquare } from "lucide-solid"
import { Spinner, StatusLine } from "./controls.tsx"
import { createPresence } from "../shell/presence.ts"
import { trapTab } from "../../lib/focus.ts"
import { enablePush, notificationsOpen, onboardingPush, openNotifications } from "../../state/onboarding.ts"

const KINDS = [
  { icon: MessageSquare, tone: "text-needs", title: "Needs you", detail: "A question, with the choices as buttons" },
  { icon: CircleCheck, tone: "text-done", title: "Finished", detail: "When a report lands" },
  { icon: CircleAlert, tone: "text-failed", title: "Failed", detail: "With what broke and a Retry link" },
] as const

export function NotificationsDialog(): JSX.Element {
  const { mounted, leaving } = createPresence(notificationsOpen, 140)
  return (
    <Show when={mounted()}>
      <Panel closing={leaving()} />
    </Show>
  )
}

function Panel(props: { closing: boolean }): JSX.Element {
  const push = onboardingPush
  const busy = (): boolean => push().kind === "working"
  const pushOn = (): boolean => push().kind === "on"
  const close = (): void => {
    if (!busy()) openNotifications(false)
  }

  let panel!: HTMLElement
  let primary!: HTMLButtonElement
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      close()
      return
    }
    trapTab(panel, event)
  }
  onMount(() => {
    primary.focus()
    document.addEventListener("keydown", onKey)
  })
  createEffect(
    on(pushOn, (isOn) => {
      if (isOn) primary.focus()
    }, { defer: true }),
  )
  onCleanup(() => {
    document.removeEventListener("keydown", onKey)
    opener?.focus()
  })

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
    <div class="fixed inset-0 z-50 grid place-items-center p-4">
      <div
        class="im-scrim absolute inset-0 bg-scrim"
        data-state={props.closing ? "closed" : "open"}
        onMouseDown={close}
        aria-hidden="true"
      />
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notify-title"
        data-state={props.closing ? "closed" : "open"}
        class="im-dialog relative w-full max-w-[440px] rounded-lg border border-line-2 bg-popover px-6 pb-5 pt-5 shadow-[var(--shadow-overlay)]"
      >
        <p class="text-sm text-ink-3">Step 5 · optional</p>
        <h2 id="notify-title" class="mt-1 text-lg font-medium tracking-[-0.01em]">
          Get a nudge when a thread needs you
        </h2>
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
              type="button"
              disabled={busy()}
              aria-busy={busy()}
              onClick={() => void enablePush()}
              class="im-press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-base font-medium text-on-accent enabled:hover:brightness-110 disabled:opacity-60"
            >
              <Show when={busy()}>
                <Spinner />
              </Show>
              Turn on
            </button>
          </Show>
        </div>
      </section>
    </div>
  )
}
