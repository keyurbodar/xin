import { createEffect, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Menu } from "@ark-ui/solid/menu"
import { Archive, Ellipsis, Menu as MenuIcon, PanelRight, Plus, Settings, X } from "lucide-solid"
import { money } from "../../lib/format.ts"
import { keyStarted } from "../../lib/motion.ts"
import { navigate } from "../../lib/router.ts"
import { visualState } from "../../lib/status.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { closeThreadTab, moveThreadTab, paneOpen, setPaneOpen, sidebarHidden, toggleSidebar, wideShell } from "../../state/tabs.ts"
import { ProjectMark } from "../chat/project-glyph.tsx"
import { Signal } from "../ui/signal.tsx"
import { openNewThread } from "./new-thread.tsx"
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from "./menu.ts"

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

const TAB =
  "group relative flex h-[var(--h-tab)] items-center gap-2 rounded-sm px-2 text-sm"

export function ConversationTabs(props: {
  project: ProjectSummary
  threads: readonly ThreadSummary[]
  activeThreadId: number | undefined
  cost: number | undefined
  onSettings: () => void
}): JSX.Element {
  const [drag, setDrag] = createSignal<Drag | undefined>()
  const [closing, setClosing] = createSignal<number>()
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

  const openTab = (id: number | undefined): void => {
    navigate(id === undefined ? `/p/${props.project.slug}` : `/p/${props.project.slug}/t/${id}`)
  }

  const close = (id: number): void => {
    const index = props.threads.findIndex((thread) => thread.id === id)
    const neighbour = props.threads[index - 1] ?? props.threads[index + 1]
    const active = props.activeThreadId === id
    const remove = (): void => {
      setClosing(undefined)
      closeThreadTab(props.project.id, id)
      if (active) openTab(neighbour?.id)
    }
    if (keyStarted()) {
      remove()
      return
    }
    setClosing(id)
    setTimeout(() => flip(remove), CLOSE_MS)
  }

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
    <div class="flex h-[var(--h-topbar)] shrink-0 items-center gap-1 border-b border-line-1 px-2">
      <Show when={!wideShell() || sidebarHidden()}>
        <button type="button" class={ICON_BUTTON} aria-label="Open the sidebar" onClick={toggleSidebar}>
          <MenuIcon {...ICON} />
        </button>
      </Show>
      <div role="tablist" class="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        <button
          type="button"
          role="tab"
          aria-selected={props.activeThreadId === undefined}
          onClick={() => openTab(undefined)}
          class={`${TAB} min-w-0 max-w-[200px] shrink-0`}
          classList={{
            "bg-hover text-ink": props.activeThreadId === undefined,
            "im-hover text-ink-3": props.activeThreadId !== undefined,
          }}
        >
          <ProjectMark slug={props.project.slug} name={props.project.name} goal={props.project.goal} size={14} class="shrink-0" />
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
                tabIndex={0}
                aria-selected={active()}
                title={thread.title}
                data-dragging={lifted() ? "" : undefined}
                data-closing={closing() === thread.id ? "" : undefined}
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
                  if (event.button === 1) close(thread.id)
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
                    close(thread.id)
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
      <button type="button" class={ICON_BUTTON} aria-label="New thread" onClick={openNewThread}>
        <Plus {...ICON} />
      </button>
      <span class="flex-1" />
      <Show when={props.cost !== undefined && props.cost > 0}>
        <span class="px-1.5 font-mono text-sm tabular-nums text-ink-2" title="Spend on this conversation">
          {money(props.cost ?? 0)}
        </span>
      </Show>
      <Menu.Root
        lazyMount
        unmountOnExit
        positioning={{ placement: "bottom-end", gutter: 6 }}
        onSelect={() => props.onSettings()}
      >
        <Menu.Trigger class={ICON_BUTTON} aria-label="Project actions">
          <Ellipsis {...ICON} />
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content class={MENU_CONTENT}>
              <Menu.Item value="settings" class={MENU_ITEM}>
                <span class="text-ink-3">
                  <Settings {...ICON} />
                </span>
                Project settings
              </Menu.Item>
              <Menu.Separator class={MENU_SEPARATOR} />
              <Menu.Item value="archive" class={MENU_ITEM}>
                <span class="text-ink-3">
                  <Archive {...ICON} />
                </span>
                Archive project…
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      <Show when={!paneOpen()}>
        <button type="button" class={ICON_BUTTON} aria-label="Show the pane" onClick={() => setPaneOpen(true)}>
          <PanelRight {...ICON} />
        </button>
      </Show>
    </div>
  )
}
