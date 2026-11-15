import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Undo2, type LucideProps } from "lucide-solid"

type Toast = {
  readonly id: number
  readonly icon: (props: LucideProps) => JSX.Element
  readonly title: string
  readonly detail: string | undefined
  readonly undo: () => void
}

const LIMIT = 5
const GAP = 8

const [toasts, setToasts] = createSignal<readonly Toast[]>([])
const [leaving, setLeaving] = createSignal<ReadonlySet<number>>(new Set())
const [heights, setHeights] = createSignal<ReadonlyMap<number, number>>(new Map())
let nextId = 0

const live = (): readonly Toast[] => toasts().filter((toast) => !leaving().has(toast.id))

/** Shows an undo toast, newest at the front; the oldest beyond the stack's five is dropped without undo. */
export function showUndoToast(toast: Omit<Toast, "id">): void {
  setToasts((list) => [{ ...toast, id: nextId++ }, ...list].slice(0, LIMIT))
}

function dismiss(id: number): void {
  setLeaving((current) => new Set([...current, id]))
}

function drop(id: number): void {
  setToasts((list) => list.filter((toast) => toast.id !== id))
  setLeaving((current) => new Set([...current].filter((entry) => entry !== id)))
  setHeights((current) => new Map([...current].filter(([entry]) => entry !== id)))
}

function undo(toast: Toast): void {
  dismiss(toast.id)
  toast.undo()
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null)
}

/** The toast stack: collapsed to the front toast, fanned out on hover, each toast's life bar its own timer. */
export function Toasts(): JSX.Element {
  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z") return
      if (editable(event.target)) return
      const newest = live()[0]
      if (newest === undefined) return
      event.preventDefault()
      undo(newest)
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const index = (id: number): number => live().findIndex((toast) => toast.id === id)

  const offset = (id: number): number =>
    live()
      .slice(0, Math.max(0, index(id)))
      .reduce((sum, toast) => sum + (heights().get(toast.id) ?? 0) + GAP, 0)

  return (
    <Portal>
      <ol
        aria-live="polite"
        aria-label="Notifications"
        class="im-toast-stack group fixed bottom-4 right-4 z-[var(--z-toast)] w-[360px] max-w-[calc(100vw-32px)]"
        style={{ height: `${heights().get(live()[0]?.id ?? -1) ?? 0}px` }}
      >
        <For each={toasts()}>
          {(toast) => {
            const gone = (): boolean => leaving().has(toast.id)
            const at = (): number => (gone() ? toasts().indexOf(toast) : index(toast.id))
            return (
              <li
                ref={(element) =>
                  onMount(() => setHeights((current) => new Map([...current, [toast.id, element.offsetHeight]])))
                }
                class="im-toast absolute inset-x-0 bottom-0 after:absolute after:inset-x-0 after:top-full after:h-2 after:content-['']"
                data-index={at()}
                data-removed={gone() ? "" : undefined}
                style={{ "--i": at(), "--offset": `${offset(toast.id)}px`, "z-index": LIMIT - at() }}
                onTransitionEnd={(event) => {
                  if (event.target === event.currentTarget && gone()) drop(toast.id)
                }}
              >
                <div class="relative flex items-center gap-3 overflow-hidden rounded-md bg-popover py-2 pl-3 pr-2 shadow-popover">
                  <div
                    class="flex min-w-0 flex-1 items-center gap-3 transition-opacity duration-[var(--dur-toast)] group-hover:opacity-100"
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
                    <Show when={at() === 0 && live().length > 1}>
                      <span class="shrink-0 text-xs text-ink-3 group-hover:hidden">+{live().length - 1} more</span>
                    </Show>
                    <button
                      type="button"
                      onClick={() => undo(toast)}
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
                    onAnimationEnd={() => dismiss(toast.id)}
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
