import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import "@ui-sdk/web/command"
import "@ui-sdk/web/popover"
import { Dynamic } from "solid-js/web"
import { Check, ChevronRight, Maximize2, Minimize2, PanelRight, Plus, X } from "lucide-solid"
import { keyStarted } from "../../lib/motion.ts"
import { visualState } from "../../lib/status.ts"
import type { CaptainProfile } from "../../lib/captains.ts"
import { projectThreads, type ProjectSummary } from "../../state/home.ts"
import { closePaneView, OVERVIEW, projectTabs, setPaneOpen, showPaneView } from "../../state/tabs.ts"
import { Signal } from "../ui/signal.tsx"
import { ICON_BUTTON } from "../shell/menu.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM, POPUP_LABEL, POPUP_SEPARATOR } from "../ui/surface.ts"
import { paneEntry, paneView, paneViews, preloadPaneViews, type PaneContext, type PaneEntry } from "./views.tsx"
import { createPaneIssues, ThreadMeta } from "./overview.tsx"
import { linkedPulls } from "../../lib/issues.ts"

const ICON = { size: 16, "stroke-width": 1.5 } as const
const LATER: ReadonlySet<string> = new Set(["threads", "pulls"])
const TWO_LINE_ITEM = POPUP_ITEM.replace("h-[var(--h-control)]", "min-h-[var(--h-control)] py-1.5")

export function ProjectPane(props: {
  project: ProjectSummary
  captain?: CaptainProfile | undefined
  conversationId: number
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onOpenThread: (id: number) => void
}): JSX.Element {
  const tabs = () => projectTabs(props.project.id)
  const context: PaneContext = {
    get project() {
      return props.project
    },
    get captain() {
      return props.captain
    },
    get conversationId() {
      return props.conversationId
    },
    onOpenThread: (id) => props.onOpenThread(id),
  }
  const issues = createPaneIssues(() => context)
  const open = (): readonly PaneEntry[] =>
    [OVERVIEW, ...tabs().pane].flatMap((id) => {
      const entry = paneEntry(id, context)
      return entry === undefined ? [] : [entry]
    })
  const view = (): PaneEntry => paneView(tabs().view, context)
  let strip!: HTMLDivElement
  const [pill, setPill] = createSignal<{ readonly x: number; readonly width: number; readonly instant: boolean }>()
  const place = (): void => {
    const active = strip.querySelector<HTMLElement>("[data-active]")
    setPill(active === null ? undefined : { x: active.offsetLeft, width: active.offsetWidth, instant: untrack(keyStarted) })
  }
  createEffect(() => {
    view()
    open()
    place()
  })
  onMount(() => {
    const observer = new ResizeObserver(place)
    observer.observe(strip)
    onCleanup(() => observer.disconnect())
  })

  return (
    <aside class="flex min-h-0 flex-col" onPointerOver={preloadPaneViews} onFocusIn={preloadPaneViews}>
      <div class="flex h-[var(--h-topbar)] shrink-0 items-center gap-1 border-b border-line-1 px-2">
        <div ref={strip} class="relative flex min-w-0 items-center gap-1 overflow-x-auto">
          <Show when={pill()}>
            {(at) => (
              <span
                class="im-pill pointer-events-none absolute inset-y-0 left-0 rounded-sm bg-hover"
                data-instant={at().instant ? "" : undefined}
                style={{ translate: `${at().x}px 0`, width: `${at().width}px` }}
              />
            )}
          </Show>
          <For each={open()}>
            {(entry) => (
              <div
                class="group relative flex h-[var(--h-tab)] shrink-0 items-center rounded-sm text-sm"
                classList={{ "text-ink": view() === entry, "im-hover text-ink-3": view() !== entry }}
                data-active={view() === entry ? "" : undefined}
              >
                <button
                  type="button"
                  class="flex h-full items-center gap-1.5 pl-2"
                  classList={{ "pr-2": entry.id === OVERVIEW }}
                  onClick={() => showPaneView(props.project.id, entry.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1 && entry.id !== OVERVIEW) closePaneView(props.project.id, entry.id)
                  }}
                >
                  <Dynamic component={entry.icon} {...ICON} />
                  {entry.label}
                </button>
                <Show when={entry.id !== OVERVIEW}>
                  <button
                    type="button"
                    aria-label={`Close ${entry.label}`}
                    class="mx-0.5 grid h-5 w-5 place-items-center rounded-xs text-ink-3 opacity-0 hover:bg-secondary hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
                    classList={{ "opacity-100": view() === entry }}
                    onClick={() => closePaneView(props.project.id, entry.id)}
                  >
                    <X size={12} stroke-width={1.5} />
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
        <ViewMenu
          views={paneViews(context)}
          project={props.project}
          current={view().id}
          onOpenThread={props.onOpenThread}
          pulls={linkedPulls(issues.issues()?.issues ?? []).length}
          pullsOf={issues.pullsOf}
        />
        <button
          type="button"
          class={`${ICON_BUTTON} ml-auto`}
          aria-label={props.expanded ? "Shrink the pane" : "Expand the pane"}
          onClick={() => props.onExpand(!props.expanded)}
        >
          <Show when={props.expanded} fallback={<Maximize2 size={14} stroke-width={1.5} />}>
            <Minimize2 size={14} stroke-width={1.5} />
          </Show>
        </button>
        <button type="button" class={ICON_BUTTON} aria-label="Hide the pane" onClick={() => setPaneOpen(false)}>
          <PanelRight {...ICON} />
        </button>
      </div>
      <Show when={view()} keyed>
        {(current) => (
          <div class="im-pane min-h-0 flex-1 overflow-y-auto p-2" data-instant={untrack(keyStarted) ? "" : undefined}>
            {untrack(() => current.render(context))}
          </div>
        )}
      </Show>
    </aside>
  )
}

export function ViewMenu(props: {
  views: readonly PaneEntry[]
  project: ProjectSummary
  current: string
  onOpenThread: (id: number) => void
  pulls?: number
  pullsOf?: (thread: number) => number
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const { mounted, settle } = createOverlayMount(open)
  const threads = () => projectThreads(props.project)
  const views = () => props.views.filter((entry) => !LATER.has(entry.id))
  const all = () => props.views.filter((entry) => entry.id === "threads")
  const pullsView = () => props.views.find((entry) => entry.id === "pulls")

  const pick = (value: string): void => {
    setOpen(false)
    if (value.startsWith("thread:")) {
      props.onOpenThread(Number(value.slice("thread:".length)))
      return
    }
    showPaneView(props.project.id, value.slice("view:".length))
  }

  return (
    <ui-popover
      prop:open={open()}
      on:openchange={(event) => {
        event.preventDefault()
        const next = event.detail.value
        queueMicrotask(() => setOpen(next))
      }}
      on:openchangecomplete={settle}
    >
      <ui-popover-trigger>
        <button type="button" class={ICON_BUTTON} aria-label="Open a view">
          <Plus {...ICON} />
        </button>
      </ui-popover-trigger>
      <ui-popover-content side="bottom" align="start" side-offset="6" class={`${POPUP} w-[320px] p-0`}>
        <Show when={mounted()}>
          <ui-command filter="contains" auto-highlight on:action={(event) => pick(event.detail.value)} class="flex flex-col">
            <div class="border-b border-line-1 px-3 pb-2 pt-2.5">
              <span class="text-mini text-ink-3">{props.project.name}</span>
              <ui-command-input>
                <input
                  autofocus
                  aria-label={`Search ${props.project.name}`}
                  placeholder="Search"
                  class="mt-1 h-6 w-full bg-transparent text-small text-ink outline-none placeholder:text-placeholder"
                />
              </ui-command-input>
            </div>
            <ui-command-empty class="hidden px-3 py-2 text-small text-ink-3 data-[empty]:block">No match</ui-command-empty>
            <ui-command-list class="flex max-h-[420px] flex-col overflow-y-auto p-1">
              <For each={views()}>
                {(entry) => (
                  <ui-command-item value={`view:${entry.id}`} label={entry.label} class={POPUP_ITEM}>
                    <span class="text-ink-3">
                      <Dynamic component={entry.icon} {...ICON} />
                    </span>
                    <span class="flex-1 truncate">{entry.label}</span>
                    <Show when={entry.id === props.current}>
                      <Check {...ICON} class="text-ink-2" />
                    </Show>
                  </ui-command-item>
                )}
              </For>
              <Show when={threads().length + all().length > 0}>
                <Show when={views().length > 0}>
                  <ui-command-separator class={POPUP_SEPARATOR} />
                </Show>
                <ui-command-group>
                  <ui-command-group-label class={POPUP_LABEL}>Crew</ui-command-group-label>
                  <For each={threads()}>
                    {(thread) => (
                      <ui-command-item value={`thread:${thread.id}`} label={thread.title} class={TWO_LINE_ITEM}>
                        <Signal state={visualState(thread.status)} size={14} class="mt-0.5 shrink-0 self-start" />
                        <span class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate">{thread.title}</span>
                          <ThreadMeta thread={thread} pulls={props.pullsOf?.(thread.id) ?? 0} />
                        </span>
                        <ChevronRight size={14} stroke-width={1.5} class="text-icon" />
                      </ui-command-item>
                    )}
                  </For>
                  <For each={all()}>
                    {(entry) => (
                      <ui-command-item value={`view:${entry.id}`} label={entry.label} class={POPUP_ITEM}>
                        <span class="text-ink-3">
                          <Dynamic component={entry.icon} {...ICON} />
                        </span>
                        <span class="flex-1">{entry.label}</span>
                        <span class="font-mono text-mini text-ink-3">{threads().length}</span>
                        <ChevronRight size={14} stroke-width={1.5} class="text-icon" />
                      </ui-command-item>
                    )}
                  </For>
                </ui-command-group>
              </Show>
              <Show when={pullsView()}>
                {(entry) => (
                  <>
                    <ui-command-separator class={POPUP_SEPARATOR} />
                    <ui-command-item value={`view:${entry().id}`} label={entry().label} class={POPUP_ITEM}>
                      <span class="text-ink-3">
                        <Dynamic component={entry().icon} {...ICON} />
                      </span>
                      <span class="flex-1">{entry().label}</span>
                      <span class="font-mono text-mini text-ink-3">{props.pulls ?? 0}</span>
                      <ChevronRight size={14} stroke-width={1.5} class="text-icon" />
                    </ui-command-item>
                  </>
                )}
              </Show>
            </ui-command-list>
          </ui-command>
        </Show>
      </ui-popover-content>
    </ui-popover>
  )
}
