import "@ui-sdk/web/popover"
import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js"
import { cachedContext, ensureContext, refreshContext, type ContextCategoryKey, type ContextReport } from "../../state/context.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP } from "../ui/surface.ts"

const CATEGORY: Readonly<Record<ContextCategoryKey, { readonly label: string; readonly color: string }>> = {
  system: { label: "System prompt", color: "bg-ink-3" },
  tools: { label: "Tools", color: "bg-merged" },
  conversation: { label: "Conversation", color: "bg-primary" },
}

function tokens(count: number): string {
  const trim = (value: number): string => value.toFixed(1).replace(/\.0$/u, "")
  if (count < 1_000) return String(count)
  if (count < 100_000) return `${trim(count / 1_000)}K`
  if (count < 1_000_000) return `${Math.round(count / 1_000)}K`
  return `${trim(count / 1_000_000)}M`
}

function Ring(props: { fraction: number }): JSX.Element {
  const radius = 6
  const length = 2 * Math.PI * radius
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" class="-rotate-90">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--color-line-3)" stroke-width="2" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke={props.fraction >= 0.9 ? "var(--color-failed)" : "var(--color-ink-2)"}
        stroke-width="2"
        stroke-linecap="round"
        stroke-dasharray={`${length}`}
        stroke-dashoffset={`${length * (1 - Math.min(1, props.fraction))}`}
        class="transition-[stroke-dashoffset] duration-[var(--dur-base)] ease-[var(--ease-enter)]"
      />
    </svg>
  )
}

/** How full the conversation's context is, read from `conv.context` on open and after each turn. */
export function ContextMeter(props: { conversation: number; busy: boolean }): JSX.Element {
  const [error, setError] = createSignal<string | undefined>()
  const [open, setOpen] = createSignal(false)
  const overlay = createOverlayMount(open)
  const report = (): ContextReport | undefined => cachedContext(props.conversation)

  const settle = (read: Promise<ContextReport>): void => {
    read
      .then(() => setError(undefined))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
  }
  const refresh = (): void => settle(refreshContext(props.conversation))

  createEffect(on(() => props.conversation, (conversation) => settle(ensureContext(conversation))))
  createEffect(
    on(
      () => props.busy,
      (busy, was) => {
        if (was === true && !busy) refresh()
      },
      { defer: true },
    ),
  )

  const fraction = (value: ContextReport): number => (value.contextWindow > 0 ? value.used / value.contextWindow : 0)
  const percent = (value: ContextReport): number => Math.round(fraction(value) * 100)

  return (
    <Show when={report()}>
      {(value) => (
        <ui-popover
          prop:open={open()}
          on:openchange={(event) => {
            event.preventDefault()
            const next = event.detail.value
            if (next) refresh()
            queueMicrotask(() => setOpen(next))
          }}
          on:openchangecomplete={overlay.settle}
        >
          <ui-popover-trigger>
            <button
              type="button"
              aria-label={`Context ${percent(value())}% used`}
              class="composer-press grid h-[var(--h-control)] w-[var(--h-control)] place-items-center rounded-sm outline-none hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary aria-expanded:bg-secondary"
            >
              <Ring fraction={fraction(value())} />
            </button>
          </ui-popover-trigger>
          <ui-popover-content side="top" align="end" side-offset="8" class={`${POPUP} w-[min(340px,calc(100vw-16px))] p-3`}>
            <Show when={overlay.mounted()}>
                <div class="flex items-baseline justify-between gap-3">
                  <ui-popover-title class="text-small font-title text-ink">Context</ui-popover-title>
                  <span class="text-xs tabular-nums text-ink-3">
                    {tokens(value().used)} / {tokens(value().contextWindow)} used ({percent(value())}%)
                  </span>
                </div>
                <div class="mt-3 flex h-1.5 gap-px overflow-hidden rounded-full bg-secondary">
                  <For each={value().categories}>
                    {(category) => (
                      <span
                        class={`h-full ${CATEGORY[category.key].color}`}
                        style={{
                          width: `${value().contextWindow > 0 ? (category.tokens / value().contextWindow) * 100 : 0}%`,
                        }}
                      />
                    )}
                  </For>
                </div>
                <ul class="mt-3 flex flex-col gap-1">
                  <For each={value().categories}>
                    {(category) => (
                      <li class="flex h-6 items-center gap-2 text-sm">
                        <span class={`h-2 w-2 shrink-0 rounded-full ${CATEGORY[category.key].color}`} />
                        <span class="flex-1 text-ink-2">{CATEGORY[category.key].label}</span>
                        <span class="tabular-nums text-ink-3">{tokens(category.tokens)}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <div class="mt-3 flex h-[var(--h-control)] items-center justify-between rounded-sm px-2.5 text-sm shadow-ring">
                  <span class="text-ink-2">Compact at</span>
                  <span class="tabular-nums">
                    <span class="text-ink">{tokens(value().compactAt)}</span>
                    <span class="text-ink-3"> / {tokens(value().contextWindow)}</span>
                  </span>
                </div>
                <Show when={!value().measured || error() !== undefined}>
                  <p class="mt-2 text-xs text-ink-3">
                    {error() ?? "Estimated until the model's next reply reports its usage."}
                  </p>
                </Show>
            </Show>
          </ui-popover-content>
        </ui-popover>
      )}
    </Show>
  )
}
