import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Menu, useMenu } from "@ark-ui/solid/menu"
import { Archive, Ellipsis, ExternalLink, Menu as MenuIcon, PanelRight, Plus, Settings, X } from "lucide-solid"
import { money } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { visualState } from "../../lib/status.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import {
  closeThreadTabs,
  moveThreadTab,
  paneOpen,
  projectTabs,
  restoreThreadTabs,
  setPaneOpen,
  sidebarHidden,
  toggleSidebar,
  wideShell,
} from "../../state/tabs.ts"
import { ProjectMark } from "../chat/project-glyph.tsx"
import { StatusGlyph } from "../ui/status-glyph.tsx"
import { showUndoToast } from "../ui/toast.tsx"
import { openNewThread } from "./new-thread.tsx"
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from "./menu.ts"

const ICON = { size: 16, "stroke-width": 1.5 } as const
const GAP = 4
const SLOP = 4

type Drag = {
  readonly id: number
  readonly startX: number
  readonly dx: number
  readonly from: number
  readonly to: number
  readonly width: number
  readonly centres: readonly number[]
}

type Point = { readonly x: number; readonly y: number }

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
  let moved = false
  const refs = new Map<number, HTMLElement>()

  const openTab = (id: number | undefined): void => {
    navigate(id === undefined ? `/p/${props.project.slug}` : `/p/${props.project.slug}/t/${id}`)
  }

  const close = (ids: readonly number[]): void => {
    const closing = props.threads.filter((thread) => ids.includes(thread.id))
    const first = closing[0]
    if (first === undefined) return
    const { id: projectId, slug } = props.project
    const before = projectTabs(projectId).threads
    const active = props.activeThreadId
    const activeClosed = active !== undefined && ids.includes(active)
    const index = props.threads.findIndex((thread) => thread.id === active)
    const kept = (thread: ThreadSummary): boolean => !ids.includes(thread.id)
    const neighbour = props.threads.slice(0, index).findLast(kept) ?? props.threads.slice(index + 1).find(kept)
    closeThreadTabs(projectId, ids)
    if (activeClosed) openTab(neighbour?.id)
    showUndoToast({
      icon: X,
      title: closing.length === 1 ? "Closed tab" : `Closed ${closing.length} tabs`,
      detail: closing.length === 1 ? `“${first.title}”` : undefined,
      undo: () => {
        restoreThreadTabs(projectId, before)
        if (activeClosed) navigate(`/p/${slug}/t/${active}`)
      },
    })
  }

  const [menuTarget, setMenuTarget] = createSignal<number | undefined>()
  const menu = useMenu({
    positioning: { placement: "bottom-start", gutter: 4 },
    onSelect: (details) => act(details.value),
  })

  const openMenu = (id: number, point: Point): void => {
    setMenuTarget(id)
    menu.api().setOpen(true)
    menu.api().reposition({ getAnchorRect: () => ({ ...point, width: 0, height: 0 }) })
  }

  const belowTab = (element: HTMLElement): Point => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.bottom }
  }

  const act = (action: string): void => {
    const id = menuTarget()
    if (id === undefined) return
    const index = props.threads.findIndex((thread) => thread.id === id)
    const others = props.threads.filter((thread) => thread.id !== id).map((thread) => thread.id)
    if (action === "window") window.open(`#/p/${props.project.slug}/t/${id}`, "_blank", "noopener")
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
    setDrag(undefined)
    if (current === undefined || !moved) return
    if (current.to !== current.from) moveThreadTab(props.project.id, current.id, current.to)
  }

  const shift = (index: number): string | undefined => {
    const current = drag()
    if (current === undefined || !moved) return undefined
    if (index === current.from) return `translateX(${current.dx}px)`
    if (index > current.from && index <= current.to) return `translateX(${-current.width}px)`
    if (index < current.from && index >= current.to) return `translateX(${current.width}px)`
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
            "text-ink-3 hover:bg-secondary hover:text-ink-2": props.activeThreadId !== undefined,
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
                data-tab-lifted={lifted()}
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
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault()
                    openMenu(thread.id, belowTab(event.currentTarget))
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  openMenu(
                    thread.id,
                    event.button === 2 ? { x: event.clientX, y: event.clientY } : belowTab(event.currentTarget),
                  )
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) close([thread.id])
                }}
                class={`${TAB} min-w-[88px] max-w-[240px] flex-1 basis-[240px] cursor-default touch-none select-none pr-1`}
                classList={{
                  "bg-hover text-ink": active(),
                  "text-ink-3 hover:bg-secondary hover:text-ink-2": !active(),
                  "z-10 bg-popover": lifted(),
                }}
                style={{
                  transform: shift(index()),
                  transition: lifted() ? "none" : drag() === undefined ? undefined : "transform var(--dur-base) var(--ease-enter)",
                }}
              >
                <StatusGlyph state={visualState(thread.status)} size={14} class="shrink-0" />
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
      <Menu.RootProvider value={menu} lazyMount unmountOnExit>
        <Portal>
          <Menu.Positioner>
            <Menu.Content class={`${MENU_CONTENT} im-pop`} aria-label="Tab actions">
              <Menu.Item value="window" class={MENU_ITEM}>
                <span class="text-ink-3">
                  <ExternalLink {...ICON} />
                </span>
                Open in new window
              </Menu.Item>
              <Menu.Separator class={MENU_SEPARATOR} />
              <Menu.Item value="close" class={MENU_ITEM}>
                <span class="text-ink-3">
                  <X {...ICON} />
                </span>
                Close
              </Menu.Item>
              <Menu.Item value="others" class={MENU_ITEM} disabled={props.threads.length < 2}>
                <span class="text-ink-3">
                  <X {...ICON} />
                </span>
                Close others
              </Menu.Item>
              <Menu.Item value="right" class={MENU_ITEM} disabled={isLast()}>
                <span class="text-ink-3">
                  <X {...ICON} />
                </span>
                Close to the right
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.RootProvider>
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
