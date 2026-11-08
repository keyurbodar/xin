import { createEffect, onCleanup, onMount, type JSX } from "solid-js"

/** A menu, a nav or a picker list where one fill slides between rows instead of repainting each row. */
export function GlideList(props: {
  class?: string | undefined
  radius?: string | undefined
  active?: string | undefined
  children: JSX.Element
}): JSX.Element {
  let host!: HTMLDivElement
  let mark!: HTMLDivElement

  const hide = (): void => {
    mark.style.opacity = "0"
  }

  const place = (item: HTMLElement | null): void => {
    if (item === null || !item.isConnected) {
      hide()
      return
    }
    mark.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`
    mark.style.width = `${item.offsetWidth}px`
    mark.style.height = `${item.offsetHeight}px`
    mark.style.opacity = "1"
  }

  const jump = (item: HTMLElement | null): void => {
    if (item === null) {
      hide()
      return
    }
    mark.dataset["jump"] = ""
    place(item)
    requestAnimationFrame(() => {
      delete mark.dataset["jump"]
    })
  }

  const itemOf = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    const item = target.closest<HTMLElement>("[data-glide-item]")
    return item !== null && host.contains(item) ? item : null
  }

  onMount(() => {
    const sizes = new ResizeObserver(() => {
      const selected = host.querySelector<HTMLElement>('[data-glide-active="true"]')
      jump(selected)
    })
    sizes.observe(host)
    onCleanup(() => sizes.disconnect())
  })

  createEffect(() => {
    const value = props.active
    if (value === undefined) return
    const selected = host.querySelector<HTMLElement>(
      `[data-glide-item][data-glide-value="${CSS.escape(value)}"]`,
    )
    jump(selected)
  })

  return (
    <div
      ref={host}
      class={`relative ${props.class ?? ""}`}
      onPointerOver={(event) => {
        const item = itemOf(event.target)
        if (item !== null) place(item)
      }}
      onPointerLeave={hide}
      onFocusIn={(event) => {
        const item = itemOf(event.target)
        if (item !== null) place(item)
      }}
      onFocusOut={(event) => {
        if (!host.contains(event.relatedTarget as Node | null)) hide()
      }}
    >
      <div
        ref={mark}
        aria-hidden="true"
        class="glide-mark"
        style={{ "border-radius": props.radius ?? "var(--radius-micro)" }}
      />
      {props.children}
    </div>
  )
}

export function MenuItem(props: {
  children: JSX.Element
  value?: string | undefined
  selected?: boolean | undefined
  disabled?: boolean | undefined
  check?: boolean | undefined
  onClick?: (() => void) | undefined
  class?: string | undefined
}): JSX.Element {
  return (
    <button
      type="button"
      role={props.check === true ? "menuitemradio" : "menuitem"}
      aria-checked={props.check === true ? props.selected === true : undefined}
      data-glide-item=""
      data-glide-value={props.value}
      data-glide-active={props.selected === true ? "true" : undefined}
      disabled={props.disabled === true}
      onClick={() => props.onClick?.()}
      class={`glide-item flex min-h-7 w-full items-center gap-2 rounded-[4px] px-2 py-1 text-left text-[13.5px] leading-[18px] text-fg disabled:opacity-40 ${props.class ?? ""}`}
    >
      {props.children}
    </button>
  )
}

export function MenuSurface(props: { children: JSX.Element; class?: string | undefined }): JSX.Element {
  return (
    <div
      role="menu"
      class={`menu-in float z-50 flex min-w-[160px] flex-col p-1 ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  )
}
