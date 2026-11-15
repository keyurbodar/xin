import { For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Undo2 } from "lucide-solid"
import {
  TOAST_LIMIT,
  dismissToast,
  leavingToast,
  liveToasts,
  setToastHeight,
  toastHeights,
  toasts,
  undoToast,
} from "../../state/toasts.ts"

const GAP = 8

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null)
}

/** The toast stack: collapsed to the front toast, fanned out on hover, each toast's life bar its own timer. */
export function Toasts(): JSX.Element {
  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z") return
      if (editable(event.target)) return
      const newest = liveToasts()[0]
      if (newest === undefined) return
      event.preventDefault()
      undoToast(newest)
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const index = (id: number): number => liveToasts().findIndex((toast) => toast.id === id)

  const offset = (id: number): number =>
    liveToasts()
      .slice(0, Math.max(0, index(id)))
      .reduce((sum, toast) => sum + (toastHeights().get(toast.id) ?? 0) + GAP, 0)

  return (
    <Portal>
      <ol
        aria-live="polite"
        aria-label="Notifications"
        class="im-toast-stack group fixed bottom-4 right-4 z-[var(--z-toast)] w-[360px] max-w-[calc(100vw-32px)]"
        style={{ height: `${toastHeights().get(liveToasts()[0]?.id ?? -1) ?? 0}px` }}
      >
        <For each={toasts()}>
          {(toast) => {
            const gone = (): boolean => leavingToast(toast.id)
            const at = (): number => (gone() ? toasts().indexOf(toast) : index(toast.id))
            return (
              <li
                ref={(element) =>
                  onMount(() => setToastHeight(toast.id, element.offsetHeight))
                }
                class="im-toast absolute inset-x-0 bottom-0 after:absolute after:inset-x-0 after:top-full after:h-2 after:content-['']"
                data-index={at()}
                data-removed={gone() ? "" : undefined}
                style={{ "--i": at(), "--offset": `${offset(toast.id)}px`, "z-index": TOAST_LIMIT - at() }}
              >
                <div class="relative flex items-center gap-3 overflow-hidden rounded-md bg-popover py-2 pl-3 pr-2 shadow-[var(--shadow-popover)]">
                  <div
                    class="flex min-w-0 flex-1 items-center gap-3 transition-opacity duration-[var(--dur-toast)] group-hover:opacity-100 group-focus-within:opacity-100"
                    classList={{ "opacity-0": at() > 0 }}
                  >
                    <span class="shrink-0 text-ink-3">
                      <toast.icon size={16} stroke-width={1.5} />
                    </span>
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-base text-ink">{toast.title}</span>
                      <Show when={toast.detail}>
                        {(detail) => <span class="truncate text-sm text-ink-3">{detail()}</span>}
                      </Show>
                    </div>
                    <Show when={at() === 0 && liveToasts().length > 1}>
                      <span class="shrink-0 text-xs text-ink-3 group-hover:hidden group-focus-within:hidden">+{liveToasts().length - 1} more</span>
                    </Show>
                    <button
                      type="button"
                      onClick={() => undoToast(toast)}
                      class="im-press flex h-7 shrink-0 items-center gap-1.5 rounded-sm bg-secondary pl-2 pr-1.5 text-sm text-ink hover:bg-hover"
                    >
                      <Undo2 size={14} stroke-width={1.5} />
                      Undo
                      <Show when={at() === 0}>
                        <span class="kbd">⌘</span>
                        <span class="kbd">Z</span>
                      </Show>
                    </button>
                  </div>
                  <span
                    class="im-toast-life absolute inset-x-0 bottom-0 h-0.5 bg-accent [--toast-life:6s]"
                    onAnimationEnd={() => dismissToast(toast.id)}
                  />
                </div>
              </li>
            )
          }}
        </For>
      </ol>
    </Portal>
  )
}
