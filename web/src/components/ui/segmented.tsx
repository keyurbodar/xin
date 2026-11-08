import { createEffect, createSignal, For, onCleanup, type JSX } from "solid-js"

export function Segmented<T extends string>(props: {
  items: readonly { readonly id: T; readonly label: JSX.Element }[]
  value: T | undefined
  onChange: (id: T) => void
  label: string
  class?: string
}): JSX.Element {
  const refs = new Map<T, HTMLButtonElement>()
  const [pill, setPill] = createSignal<{ left: number; width: number }>()
  let observer: ResizeObserver | undefined

  const measure = (): void => {
    const value = props.value
    const element = value === undefined ? undefined : refs.get(value)
    if (element === undefined) {
      setPill(undefined)
      return
    }
    setPill({ left: element.offsetLeft, width: element.offsetWidth })
  }

  createEffect(() => {
    void props.items
    void props.value
    measure()
    observer ??= new ResizeObserver(measure)
    observer.disconnect()
    for (const button of refs.values()) observer.observe(button)
  })

  onCleanup(() => observer?.disconnect())

  return (
    <div
      role="group"
      aria-label={props.label}
      class={`relative flex h-[34px] shrink-0 items-center rounded-[8px] border border-line bg-fill p-0.5 ${props.class ?? ""}`}
    >
      <span
        aria-hidden="true"
        class="pointer-events-none absolute top-0.5 h-[30px] rounded-[6px] bg-selected shadow-[var(--shadow-sm)] transition-[left,width] duration-200 ease-[var(--ease-kiko)]"
        classList={{ "opacity-0": pill() === undefined }}
        style={{ left: `${pill()?.left ?? 0}px`, width: `${pill()?.width ?? 0}px` }}
      />
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            aria-pressed={props.value === item.id}
            ref={(element) => {
              refs.set(item.id, element)
            }}
            onClick={() => props.onChange(item.id)}
            class="relative z-10 flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px]"
            classList={{
              "text-fg": props.value === item.id,
              "text-fg-3 hover:text-fg-2": props.value !== item.id,
            }}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  )
}
