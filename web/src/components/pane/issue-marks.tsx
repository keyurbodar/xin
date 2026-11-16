import { For, Show, type JSX } from "solid-js"
import { initials, PRIORITY_LABEL, type Priority, type StateTone } from "../../lib/issues.ts"

const TONE_CLASS: Readonly<Record<StateTone, string>> = {
  needs: "text-needs",
  review: "text-done",
  progress: "text-working",
  waiting: "text-ink-3",
  todo: "text-ink-3",
  backlog: "text-icon",
  done: "text-done",
  canceled: "text-icon",
}

const TONE_FILL: Readonly<Partial<Record<StateTone, number>>> = { needs: 1, review: 0.75, progress: 0.5, waiting: 0.25 }

const PIE = 2 * Math.PI * 2.5

/** A 16px state ring: the inner pie fills as work moves toward review; closed states are solid. */
export function StateMark(props: { tone: StateTone; class?: string; label?: string | undefined }): JSX.Element {
  const fill = (): number => TONE_FILL[props.tone] ?? 0
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      role={props.label === undefined ? undefined : "img"}
      aria-label={props.label}
      aria-hidden={props.label === undefined ? true : undefined}
      class={`shrink-0 ${TONE_CLASS[props.tone]} ${props.class ?? ""}`}
    >
      <Show
        when={props.tone === "done" || props.tone === "canceled"}
        fallback={
          <>
            <circle
              cx="8"
              cy="8"
              r="6.25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-dasharray={props.tone === "backlog" ? "2.2 2.2" : undefined}
            />
            <Show when={fill() > 0}>
              <circle
                cx="8"
                cy="8"
                r="2.5"
                fill="none"
                stroke="currentColor"
                stroke-width="5"
                stroke-dasharray={`${fill() * PIE} ${PIE}`}
                transform="rotate(-90 8 8)"
              />
            </Show>
          </>
        }
      >
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <Show
          when={props.tone === "done"}
          fallback={<path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" stroke="var(--color-panel)" stroke-width="1.5" stroke-linecap="round" />}
        >
          <path d="M5 8.2l2 2 4-4.2" fill="none" stroke="var(--color-panel)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </Show>
      </Show>
    </svg>
  )
}

const BARS: Readonly<Record<Exclude<Priority, "urgent">, number>> = { high: 3, normal: 2, low: 1 }

/** Priority as three rising bars, or a filled alert square for urgent. */
export function PriorityMark(props: { priority: Priority; class?: string; decorative?: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 14"
      width="16"
      height="14"
      role={props.decorative === true ? undefined : "img"}
      aria-label={props.decorative === true ? undefined : `${PRIORITY_LABEL[props.priority]} priority`}
      aria-hidden={props.decorative === true ? true : undefined}
      class={`shrink-0 ${props.class ?? ""}`}
    >
      <Show
        when={props.priority !== "urgent" ? props.priority : undefined}
        fallback={
          <>
            <rect x="1.5" y="0.5" width="13" height="13" rx="3" class="fill-failed" />
            <path d="M8 3.75v4.5M8 10.25v.01" stroke="var(--color-panel)" stroke-width="1.75" stroke-linecap="round" />
          </>
        }
      >
        {(level) => (
          <For each={[0, 1, 2]}>
            {(bar) => (
              <rect
                x={2 + bar * 4.5}
                y={9 - bar * 3.5}
                width="3"
                height={4 + bar * 3.5}
                rx="1"
                class={bar < BARS[level()] ? "fill-ink-2" : "fill-muted"}
              />
            )}
          </For>
        )}
      </Show>
    </svg>
  )
}

/** A round 18px chip for one assignee, with a +n tail when more share the issue. */
export function AssigneeChip(props: { names: readonly string[] }): JSX.Element {
  return (
    <Show when={props.names[0]}>
      {(first) => (
        <span class="flex shrink-0 items-center gap-1" title={props.names.join(", ")}>
          <span class="grid h-[18px] w-[18px] place-items-center rounded-full bg-muted font-mono text-[9px] font-medium text-ink-2">
            {initials(first())}
          </span>
          <Show when={props.names.length > 1}>
            <span class="font-mono text-2xs text-ink-3">+{props.names.length - 1}</span>
          </Show>
        </span>
      )}
    </Show>
  )
}
