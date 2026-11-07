import { For, Show, type JSX } from "solid-js"
import { Icon } from "../ui/icon.tsx"

export type RailState = "done" | "current" | "todo"

export type RailItem = { readonly label: string; readonly state: RailState }

/** The wordmark slot stays a placeholder until the owner names the product. */
export function Wordmark(): JSX.Element {
  return (
    <span class="rounded-[2px] border border-dashed border-line-strong px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-3">
      Name TBD
    </span>
  )
}

export function StepRail(props: { items: readonly RailItem[]; onSelect?: ((index: number) => void) | undefined }): JSX.Element {
  const current = (): number => {
    const index = props.items.findIndex((item) => item.state === "current")
    return index === -1 ? 0 : index
  }

  return (
    <>
      <span class="ml-auto font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-4 md:hidden">
        Step {current() + 1} of {props.items.length}
      </span>
      <div class="ml-auto hidden items-center gap-1.5 md:flex">
        <For each={props.items}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <span
                  class="mx-1.5 h-px w-7"
                  classList={{ "bg-fg": props.items[index() - 1]?.state === "done", "bg-line-inner": props.items[index() - 1]?.state !== "done" }}
                />
              </Show>
              <button
                type="button"
                disabled={item.state === "todo" || props.onSelect === undefined}
                onClick={() => props.onSelect?.(index())}
                class="flex items-center gap-1.5 rounded-[2px] text-[12px] transition-none"
                classList={{
                  "cursor-default text-fg-4": item.state === "todo",
                  "text-fg": item.state === "current",
                  "text-fg-3 enabled:hover:text-fg-2": item.state === "done",
                }}
              >
                <span
                  class="grid h-5 w-5 place-items-center rounded-[2px] border font-mono text-[10.5px]"
                  classList={{
                    "border-line-inner text-fg-4": item.state === "todo",
                    "border-accent text-accent-text": item.state === "current",
                    "border-fg bg-fg text-page": item.state === "done",
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
    <header class="flex h-14 shrink-0 items-center gap-4 border-b border-line px-6">
      <Wordmark />
      <StepRail items={props.items} onSelect={props.onSelect} />
    </header>
  )
}
