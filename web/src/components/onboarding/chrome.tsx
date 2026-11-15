import { For, Show, type JSX } from "solid-js"
import { BrandMark } from "../ui/brand-mark.tsx"
import { Icon } from "../ui/icon.tsx"

export type RailState = "done" | "current" | "todo"

export type RailItem = { readonly label: string; readonly state: RailState }

function Wordmark(): JSX.Element {
  return (
    <span class="flex items-center gap-2 text-sm font-medium text-ink">
      <BrandMark />
      <span aria-hidden="true">Ingle</span>
    </span>
  )
}

function StepRail(props: { items: readonly RailItem[]; onSelect?: ((index: number) => void) | undefined }): JSX.Element {
  const current = (): number => {
    const index = props.items.findIndex((item) => item.state === "current")
    return index === -1 ? 0 : index
  }

  return (
    <>
      <span class="ml-auto font-mono text-2xs uppercase tracking-[0.08em] text-icon md:hidden">
        Step {current() + 1} of {props.items.length}
      </span>
      <div class="ml-auto hidden items-center gap-1.5 md:flex">
        <For each={props.items}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <span
                  class="mx-1.5 h-px w-7"
                  classList={{ "bg-ink": props.items[index() - 1]?.state === "done", "bg-line-2": props.items[index() - 1]?.state !== "done" }}
                />
              </Show>
              <button
                type="button"
                disabled={item.state === "todo" || props.onSelect === undefined}
                onClick={() => props.onSelect?.(index())}
                class="flex items-center gap-1.5 rounded-sm text-sm"
                classList={{
                  "cursor-default text-icon": item.state === "todo",
                  "text-ink": item.state === "current",
                  "text-ink-3 enabled:hover:text-ink-2": item.state === "done",
                }}
              >
                <span
                  class="grid h-5 w-5 place-items-center rounded-sm border font-mono text-2xs"
                  classList={{
                    "border-line-2 text-icon": item.state === "todo",
                    "border-primary text-primary-ink": item.state === "current",
                    "border-ink bg-ink text-bg": item.state === "done",
                  }}
                >
                  <Show when={item.state === "done"} fallback={index() + 1}>
                    <Icon name="check" size={11} strokeWidth={2} />
                  </Show>
                </span>
                {item.label}
              </button>
            </>
          )}
        </For>
      </div>
    </>
  )
}

export function OnboardingTopBar(props: { items: readonly RailItem[]; onSelect?: (index: number) => void }): JSX.Element {
  return (
    <header class="flex h-14 shrink-0 items-center gap-4 border-b border-line-1 px-6">
      <Wordmark />
      <StepRail items={props.items} onSelect={props.onSelect} />
    </header>
  )
}
