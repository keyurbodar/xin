import { For, Show, type JSX } from "solid-js"
import { BrandMark } from "../ui/brand-mark.tsx"
import { Icon } from "../ui/icon.tsx"
import { ONBOARDING_STEPS } from "../../state/onboarding.ts"

function StepRail(props: { current: number; done: (index: number) => boolean; onSelect?: ((index: number) => void) | undefined }): JSX.Element {
  return (
    <ol class="flex items-center justify-center gap-2.5" aria-label="Setup steps">
      <For each={ONBOARDING_STEPS}>
        {(step, index) => {
          const state = (): "done" | "current" | "todo" =>
            index() === props.current ? "current" : props.done(index()) ? "done" : "todo"
          return (
            <li class="flex items-center gap-2.5">
              <Show when={index() > 0}>
                <span class="hidden h-px w-6 bg-line-2 sm:block" />
              </Show>
              <button
                type="button"
                disabled={state() !== "done" || props.onSelect === undefined || index() === 0}
                onClick={() => props.onSelect?.(index())}
                aria-current={state() === "current" ? "step" : undefined}
                class="im-press flex items-center gap-2 rounded-sm text-sm disabled:cursor-default"
                classList={{
                  "text-ink": state() === "current",
                  "text-ink-3 enabled:hover:text-ink-2": state() === "done",
                  "text-ink-3": state() === "todo",
                }}
              >
                <span
                  class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-2xs tabular-nums transition-colors duration-200"
                  classList={{
                    "bg-accent text-on-accent": state() === "current",
                    "bg-done text-bg": state() === "done",
                    "bg-secondary text-ink-2": state() === "todo",
                  }}
                >
                  <Show when={state() === "done"} fallback={index() + 1}>
                    <Icon name="check" size={12} strokeWidth={2.25} />
                  </Show>
                </span>
                <span class="hidden sm:inline">{step.label}</span>
              </button>
            </li>
          )
        }}
      </For>
    </ol>
  )
}

export function OnboardingFrame(props: {
  current: number
  done: (index: number) => boolean
  onSelect?: (index: number) => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div class="flex h-full flex-col bg-bg text-ink">
      <header class="flex h-14 shrink-0 items-center gap-2 px-6">
        <BrandMark class="h-5 w-5 text-ink" />
        <span class="text-[15px] font-semibold tracking-[-0.02em]">ingle</span>
        <span class="ml-auto truncate text-sm text-ink-3">Self-hosted · Worker {location.host}</span>
      </header>
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-16">
        <div class="my-auto flex w-full flex-col items-center gap-6 pt-6">
          <StepRail current={props.current} done={props.done} onSelect={props.onSelect} />
          {props.children}
        </div>
      </div>
    </div>
  )
}
