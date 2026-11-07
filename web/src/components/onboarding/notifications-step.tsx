import { For, type JSX } from "solid-js"
import { Icon, type IconName } from "../ui/icon.tsx"
import { navigate } from "../../lib/router.ts"
import { StatusGlyph } from "../ui/status-glyph.tsx"
import type { VisualState } from "../../lib/status.ts"
import { GhostButton, PrimaryButton, StatusLine } from "./controls.tsx"
import { enablePush, onboardingProject, onboardingPush, previousStep, projectPath } from "../../state/onboarding.ts"

type Preview = {
  readonly icon: IconName
  readonly project: string
  readonly title: string
  readonly detail: string
}

const PREVIEWS: readonly Preview[] = [
  {
    icon: "inbox",
    project: "Onboarding",
    title: "Which payroll vendor should I go with?",
    detail: "Gusto · Rippling · Deel",
  },
  {
    icon: "sliders",
    project: "Q4 pipeline",
    title: "Finished: Find deals that slipped",
    detail: "19 deals moved out of Q4",
  },
  {
    icon: "file",
    project: "Invoices",
    title: "Failed: Match October payments",
    detail: "Stripe returned 401 · Retry",
  },
]

const KINDS: readonly { readonly state: VisualState; readonly title: string; readonly detail: string }[] = [
  { state: "waiting", title: "Waiting on you", detail: "A question, with the choices as buttons" },
  { state: "done", title: "Finished", detail: "When a report lands" },
  { state: "failed", title: "Failed", detail: "With what broke and a Retry link" },
]

export function NotificationsStep(): JSX.Element {
  const push = onboardingPush
  const project = onboardingProject
  const busy = (): boolean => push().kind === "working"
  const on = (): boolean => push().kind === "on"

  const statusText = (): string | undefined => {
    const outcome = push()
    switch (outcome.kind) {
      case "idle":
        return undefined
      case "working":
        return "Waiting for the browser’s permission prompt."
      case "on":
        return "This browser is subscribed to push."
      case "off":
        return outcome.message
    }
  }

  const statusTone = (): "error" | "ok" | "muted" => {
    const outcome = push()
    switch (outcome.kind) {
      case "on":
        return "ok"
      case "off":
        return "error"
      default:
        return "muted"
    }
  }

  const finish = (): void => navigate(projectPath(project()))

  return (
    <div class="enter px-6 pb-16 pt-12 md:pt-16">
      <div class="mx-auto w-full max-w-[560px] overflow-hidden rounded-[4px] border border-line-inner bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.45)]">
        <div class="relative h-[200px] overflow-hidden border-b border-line bg-page">
          <For each={PREVIEWS}>
            {(preview, index) => (
              <div
                class="absolute left-1/2 flex w-[360px] max-w-[calc(100%_-_32px)] items-start gap-2.5 rounded-[4px] border border-line-strong bg-raised px-3 py-2.5 text-[12.5px] shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                style={{
                  top: `${56 + index() * 10}px`,
                  transform: `translateX(-50%) scale(${1 - index() * 0.04}) translateY(${index() * 8}px)`,
                  opacity: 1 - index() * 0.3,
                  "z-index": 3 - index(),
                }}
              >
                <span class="grid h-7 w-7 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-raised text-fg-2">
                  <Icon name={preview.icon} size={14} />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="truncate font-medium">{preview.project}</span>
                    <span class="shrink-0 text-[11px] text-fg-3">now</span>
                  </div>
                  <div class="truncate text-fg-2">{preview.title}</div>
                  <div class="truncate text-fg-3">{preview.detail}</div>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="flex flex-col gap-3.5 px-6 py-5">
          <span class="label">Step 4 · optional</span>
          <h2 class="text-[17px] font-medium tracking-[-0.02em]">Get a nudge when a thread needs you</h2>
          <p class="text-[13.5px] leading-[1.55] text-fg-2">
            Threads keep working after you close the tab. Turn on push and we’ll only tell you about these three things.
          </p>

          <div>
            <For each={KINDS}>
              {(kind) => (
                <div class="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
                  <span class="grid h-7 w-7 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-surface">
                    <StatusGlyph state={kind.state} size={14} />
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="text-[13px] font-medium">{kind.title}</div>
                    <p class="text-[12px] text-fg-3">{kind.detail}</p>
                  </div>
                  <span class="relative ml-auto h-4 w-7 shrink-0 rounded-[2px] bg-fg" aria-hidden="true">
                    <span class="absolute left-3.5 top-0.5 h-3 w-3 rounded-[1px] bg-page" />
                  </span>
                </div>
              )}
            </For>
          </div>

          <StatusLine tone={statusTone()} text={statusText()} />
        </div>

        <div class="flex items-center gap-2 border-t border-line px-6 py-3.5">
          <span class="mr-auto text-[11.5px] text-fg-3">Change this any time in Settings → Notifications</span>
          <GhostButton label="Back" onClick={previousStep} />
          <GhostButton label="Not now" onClick={finish} />
          <PrimaryButton
            label={on() ? "Finish" : "Turn on"}
            busy={busy()}
            icon={<Icon name="bell" size={14} />}
            onClick={() => {
              if (on()) finish()
              else void enablePush()
            }}
          />
        </div>
      </div>
    </div>
  )
}
