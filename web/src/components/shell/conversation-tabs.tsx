import { createEffect, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Ellipsis, ExternalLink, Menu as MenuIcon, PanelRight, Plus, X, type LucideProps } from "lucide-solid"
import { money } from "../../lib/format.ts"
import { keyStarted } from "../../lib/motion.ts"
import { navigate } from "../../lib/router.ts"
import { visualState } from "../../lib/status.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import {
  closeThreadTabs,
  moveThreadTab,
  paneOpen,
  forgetThreadTabs,
  reopenThreadTabs,
  setPaneOpen,
  sidebarHidden,
  toggleSidebar,
  wideShell,
} from "../../state/tabs.ts"
import { Breadcrumb, type Crumb } from "../ui/breadcrumb.tsx"
import { Signal } from "../ui/signal.tsx"
import { showToast } from "../../state/toasts.ts"
import { nearestKept } from "../../lib/tab-order.ts"
import { replayWhenReady, warmUiSdk } from "../../lib/ui-sdk-lazy.ts"
import { POPUP, POPUP_ITEM, POPUP_SEPARATOR } from "../ui/surface.ts"
import { ICON_BUTTON } from "./menu.ts"

const ICON = { size: 16, "stroke-width": 1.5 } as const
const GAP = 4
const SLOP = 4
const CLOSE_MS = 140

type Drag = {
  readonly id: number
  readonly startX: number
  readonly dx: number
  readonly from: number
  readonly to: number
  readonly width: number
  readonly centres: readonly number[]
}

/** One row of the conversation's menu; `separated` draws a rule above it. */
export type ConversationAction = {
  readonly value: string
  readonly label: string
  readonly icon: (props: LucideProps) => JSX.Element
  readonly separated?: boolean
}

const TAB =
  "group relative flex h-[var(--h-tab)] items-center gap-2 rounded-sm px-2 text-sm"

const warm = (): void => warmUiSdk("menu")

const threadOf = (target: EventTarget | null): number | undefined => {
  const tab = target instanceof Element ? target.closest<HTMLElement>("[data-thread]") : null
  return tab === null ? undefined : Number(tab.dataset.thread)
}

export function ConversationTabs(props: {
  project: ProjectSummary
  base: string
  mark: JSX.Element
  threads: readonly ThreadSummary[]
  activeThreadId: number | undefined
  cost: number | undefined
  actions: readonly ConversationAction[]
  onAction: (value: string) => void
  onNewThread?: (() => void) | undefined
}): JSX.Element {
  const [drag, setDrag] = createSignal<Drag | undefined>()
  const [closing, setClosing] = createSignal<readonly number[]>([])
  const [settled, setSettled] = createSignal(false)
  let moved = false
  const refs = new Map<number, HTMLElement>()
  onMount(() => requestAnimationFrame(() => setSettled(true)))

  const flip = (change: () => void): void => {
    const tabs = props.threads.flatMap((thread) => {
      const element = refs.get(thread.id)
      return element === undefined ? [] : [{ id: thread.id, element, left: element.getBoundingClientRect().left }]
    })
    for (const tab of tabs) tab.element.toggleAttribute("data-flip-start", true)
    change()
    for (const tab of tabs) {
      if (!tab.element.isConnected) continue
      const dx = tab.left - tab.element.getBoundingClientRect().left
      tab.element.style.translate = dx === 0 ? "" : `${dx}px 0`
    }
    void document.body.offsetWidth
    for (const tab of tabs) {
      tab.element.toggleAttribute("data-flip-start", false)
      tab.element.style.translate = ""
    }
  }

  let projectTab: HTMLButtonElement | undefined

  const focusTab = (id: number | undefined): void => {
    requestAnimationFrame(() => {
      const element = id === undefined ? undefined : refs.get(id)
      const target = element?.isConnected === true ? element : (refs.get(props.activeThreadId ?? -1) ?? projectTab)
      target?.focus({ preventScroll: true })
    })
  }

  const openTab = (id: number | undefined): void => {
    navigate(id === undefined ? props.base : `${props.base}/t/${id}`)
  }

  const close = (ids: readonly number[]): void => {
    const closingTabs = props.threads.filter((thread) => ids.includes(thread.id))
    const first = closingTabs[0]
    if (first === undefined) return
    const projectId = props.project.id
    const order = props.threads.map((thread) => thread.id)
    const active = props.activeThreadId
    const activeClosed = active !== undefined && ids.includes(active)
    const remove = (): void => {
      const focused = ids.find((id) => refs.get(id)?.contains(document.activeElement) === true)
      setClosing([])
      const closeId = closeThreadTabs(projectId, ids)
      if (activeClosed) openTab(nearestKept(order, ids, active))
      if (focused !== undefined) focusTab(nearestKept(order, ids, focused))
      showToast({
        icon: X,
        title: closingTabs.length === 1 ? "Closed tab" : `Closed ${closingTabs.length} tabs`,
        detail: closingTabs.length === 1 ? `“${first.title}”` : undefined,
        undo: () => {
          reopenThreadTabs(projectId, closeId)
          if (activeClosed) openTab(active)
          focusTab(activeClosed ? active : first.id)
        },
        expire: () => forgetThreadTabs(projectId, closeId),
      })
    }
    if (keyStarted()) {
      remove()
      return
    }
    setClosing(ids)
    setTimeout(() => flip(remove), CLOSE_MS)
  }

  const [menuTarget, setMenuTarget] = createSignal<number | undefined>()
  const activeThread = (): ThreadSummary | undefined =>
    props.threads.find((thread) => thread.id === props.activeThreadId)
  const crumbs = (): Crumb[] => {
    const project = { label: props.project.name, href: `#${props.base}`, lead: props.mark }
    const thread = activeThread()
    return thread === undefined ? [project] : [project, { label: thread.title, href: `#${props.base}/t/${thread.id}` }]
  }

  const act = (action: string): void => {
    const id = menuTarget()
    if (id === undefined) return
    const index = props.threads.findIndex((thread) => thread.id === id)
    const others = props.threads.filter((thread) => thread.id !== id).map((thread) => thread.id)
    if (action === "window") window.open(`#${props.base}/t/${id}`, "_blank", "noopener")
    if (action === "close") close([id])
    if (action === "others") close(others)
    if (action === "right") close(props.threads.slice(index + 1).map((thread) => thread.id))
  }

  const isLast = (): boolean => props.threads.at(-1)?.id === menuTarget()

  const down = (event: PointerEvent, id: number, index: number): void => {
    if (event.button !== 0) return
    const element = refs.get(id)
    if (element === undefined) return
    moved = false
    const centres = props.threads.map((thread) => {
      const rect = refs.get(thread.id)?.getBoundingClientRect()
      return rect === undefined ? 0 : rect.left + rect.width / 2
    })
    setDrag({ id, startX: event.clientX, dx: 0, from: index, to: index, width: element.offsetWidth + GAP, centres })
  }

  const move = (event: PointerEvent): void => {
    const current = drag()
    if (current === undefined) return
    const dx = event.clientX - current.startX
    if (!moved && Math.abs(dx) < SLOP) return
    if (!moved) {
      moved = true
      refs.get(current.id)?.setPointerCapture(event.pointerId)
    }
    const centre = (current.centres[current.from] ?? 0) + dx
    const to = current.centres.filter((value, index) => index !== current.from && value < centre).length
    setDrag({ ...current, dx, to })
  }

  const up = (): void => {
    const current = drag()
    if (current === undefined || !moved) {
      setDrag(undefined)
      return
    }
    flip(() => {
      setDrag(undefined)
      if (current.to !== current.from) moveThreadTab(props.project.id, current.id, current.to)
    })
  }

  const shift = (index: number): string | undefined => {
    const current = drag()
    if (current === undefined || !moved || index === current.from) return undefined
    if (index > current.from && index <= current.to) return `${-current.width}px 0`
    if (index < current.from && index >= current.to) return `${current.width}px 0`
    return undefined
  }

  return (
    <header class="shrink-0 border-b border-line-1" onPointerEnter={warm} onFocusIn={warm}>
      <div class="flex h-[var(--h-topbar)] items-center gap-1 px-2">
        <Show when={!wideShell() || sidebarHidden()}>
          <button type="button" class={ICON_BUTTON} aria-label="Open the sidebar" onClick={toggleSidebar}>
            <MenuIcon {...ICON} />
          </button>
        </Show>
        <Breadcrumb class="flex-1 pl-1" crumbs={crumbs()} />
        <Show when={props.cost !== undefined && props.cost > 0}>
          <span class="px-1.5 font-mono text-sm tabular-nums text-ink-2" title="Spend on this conversation">
            {money(props.cost ?? 0)}
          </span>
        </Show>
        <ui-menu on:action={(event) => props.onAction(event.detail.value)}>
          <ui-menu-trigger>
            <button
              type="button"
              class={ICON_BUTTON}
              aria-label={`${props.project.name} actions`}
              onClick={(event) => replayWhenReady(["menu"], event)}
            >
              <Ellipsis {...ICON} />
            </button>
          </ui-menu-trigger>
          <ui-menu-content hidden side="bottom" align="end" side-offset="6" class={`${POPUP} w-[220px]`}>
            <For each={props.actions}>
              {(action) => (
                <>
                  <Show when={action.separated === true}>
                    <ui-menu-separator class={POPUP_SEPARATOR} />
                  </Show>
                  <ui-menu-item value={action.value} class={POPUP_ITEM}>
                    <span class="text-ink-3">
                      <Dynamic component={action.icon} {...ICON} />
                    </span>
                    {action.label}
                  </ui-menu-item>
                </>
              )}
            </For>
          </ui-menu-content>
        </ui-menu>
        <Show when={!paneOpen()}>
          <button type="button" class={ICON_BUTTON} aria-label="Show the pane" onClick={() => setPaneOpen(true)}>
            <PanelRight {...ICON} />
          </button>
        </Show>
      </div>
      <div class="flex items-center gap-1 px-2 pb-1.5">
        <ui-menu
          class="min-w-0"
          on:openchange={(event) => {
            if (event.detail.value && menuTarget() === undefined) event.preventDefault()
          }}
          on:openchangecomplete={(event) => {
            if (!event.detail.value) focusTab(menuTarget())
          }}
          on:action={(event) => act(event.detail.value)}
        >
          <ui-menu-context-trigger class="min-w-0">
            <div
              role="tablist"
              class="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
              on:pointerdown={(event) => setMenuTarget(threadOf(event.target))}
              on:contextmenu={(event) => {
                setMenuTarget(threadOf(event.target))
                if (menuTarget() === undefined) return
                replayWhenReady(["menu"], event)
              }}
            >
              <button
                type="button"
                ref={projectTab}
                role="tab"
                aria-selected={props.activeThreadId === undefined}
                onClick={() => openTab(undefined)}
                class={`${TAB} min-w-0 max-w-[200px] shrink-0`}
                classList={{
                  "bg-hover text-ink": props.activeThreadId === undefined,
                  "im-hover text-ink-3": props.activeThreadId !== undefined,
                }}
              >
                {props.mark}
                <span class="truncate">{props.project.name}</span>
              </button>
              <For each={props.threads}>
                {(thread, index) => {
                  const active = (): boolean => props.activeThreadId === thread.id
                  const lifted = (): boolean => drag()?.id === thread.id && moved
                  return (
                    <div
                      ref={(element) => {
                        refs.set(thread.id, element)
                        createEffect(() => {
                          if (active()) element.scrollIntoView({ block: "nearest", inline: "nearest" })
                        })
                      }}
                      role="tab"
                      data-thread={thread.id}
                      tabIndex={0}
                      aria-selected={active()}
                      title={thread.title}
                      data-dragging={lifted() ? "" : undefined}
                      data-closing={closing().includes(thread.id) ? "" : undefined}
                      data-instant={settled() ? undefined : ""}
                      onPointerDown={(event) => down(event, thread.id, index())}
                      onPointerMove={move}
                      onPointerUp={up}
                      onPointerCancel={up}
                      onClick={() => {
                        if (!moved) openTab(thread.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return
                        if (event.key === "Enter" || event.key === " ") openTab(thread.id)
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1) close([thread.id])
                      }}
                      class={`${TAB} im-tab im-lift im-flip min-w-[88px] max-w-[240px] flex-1 basis-[240px] cursor-default touch-none select-none pr-1`}
                      classList={{
                        "bg-hover text-ink": active(),
                        "im-hover text-ink-3": !active(),
                        "bg-popover": lifted(),
                      }}
                      style={{
                        translate: shift(index()),
                        "--drag-x": lifted() ? `${drag()?.dx ?? 0}px` : undefined,
                      }}
                    >
                      <Signal state={visualState(thread.status)} size={14} class="shrink-0" />
                      <span class="min-w-0 flex-1 truncate">{thread.title}</span>
                      <button
                        type="button"
                        aria-label={`Close ${thread.title}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          close([thread.id])
                        }}
                        class="grid h-5 w-5 shrink-0 place-items-center rounded-xs text-ink-3 opacity-0 hover:bg-secondary hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
                        classList={{ "opacity-100": active() }}
                      >
                        <X size={12} stroke-width={1.5} />
                      </button>
                    </div>
                  )
                }}
              </For>
            </div>
          </ui-menu-context-trigger>
          <ui-menu-content
            hidden
            final-focus="none"
            side-offset="4"
            class={`${POPUP} w-[220px]`}
            aria-label="Tab actions"
          >
            <ui-menu-item value="window" class={POPUP_ITEM}>
              <span class="text-ink-3">
                <ExternalLink {...ICON} />
              </span>
              Open in new window
            </ui-menu-item>
            <ui-menu-separator class={POPUP_SEPARATOR} />
            <ui-menu-item value="close" class={POPUP_ITEM}>
              <span class="text-ink-3">
                <X {...ICON} />
              </span>
              Close
            </ui-menu-item>
            <ui-menu-item value="others" class={POPUP_ITEM} disabled={props.threads.length < 2}>
              <span class="text-ink-3">
                <X {...ICON} />
              </span>
              Close others
            </ui-menu-item>
            <ui-menu-item value="right" class={POPUP_ITEM} disabled={isLast()}>
              <span class="text-ink-3">
                <X {...ICON} />
              </span>
              Close to the right
            </ui-menu-item>
          </ui-menu-content>
        </ui-menu>
        <Show when={props.onNewThread}>
          {(open) => (
            <button type="button" class={ICON_BUTTON} aria-label="New thread" onClick={() => open()()}>
              <Plus {...ICON} />
            </button>
          )}
        </Show>
      </div>
    </header>
  )
}
