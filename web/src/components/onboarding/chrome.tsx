import { createUniqueId, For, Show, type JSX } from "solid-js"
import { Icon } from "../ui/icon.tsx"
import { ONBOARDING_STEPS } from "../../state/onboarding.ts"

export function IngleMark(props: { size: number; class?: string }): JSX.Element {
  const mask = createUniqueId()
  return (
    <svg width={props.size} height={props.size} viewBox="20 16 80 80" fill="none" aria-hidden="true" class={props.class}>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="20" y="16" width="80" height="80">
          <rect x="20" y="16" width="80" height="80" fill="black" />
          <g transform="translate(48.5 57.5) rotate(-38)">
            <path d="M0 0C13-6 13-24 0-33C-13-24-13-6 0 0Z" fill="white" />
          </g>
          <path
            d="M31 95C26 95 24 92 24.4 87C26.2 66 40.5 53 60 53C79.5 53 93.8 66 95.6 87C96 92 94 95 89 95Z"
            fill="white"
            stroke="black"
            stroke-width="8.4"
            stroke-linejoin="round"
            paint-order="stroke"
          />
          <g transform="translate(68 55.5) rotate(22)">
            <path
              d="M0 0C14-7 14-27 0-37C-14-27-14-7 0 0Z"
              fill="white"
              stroke="black"
              stroke-width="8.4"
              stroke-linejoin="round"
              paint-order="stroke"
            />
          </g>
          <circle cx="46.4" cy="74" r="4.6" fill="black" />
          <circle cx="70.6" cy="72.6" r="4.6" fill="black" />
        </mask>
      </defs>
      <rect x="20" y="16" width="80" height="80" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  )
}

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
        <IngleMark size={20} class="text-ink" />
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
