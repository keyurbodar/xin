import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import { Popover } from "@ark-ui/solid/popover"
import { Listbox, createListCollection } from "@ark-ui/solid/listbox"
import { Check, ChevronRight, Maximize2, Minimize2, PanelRight, Plus, X } from "lucide-solid"
import { keyStarted } from "../../lib/motion.ts"
import { visualState } from "../../lib/status.ts"
import { projectThreads, type ProjectSummary } from "../../state/home.ts"
import { closePaneView, OVERVIEW, projectTabs, setPaneOpen, showPaneView } from "../../state/tabs.ts"
import { Signal } from "../ui/signal.tsx"
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM, MENU_LABEL, MENU_SEPARATOR } from "../shell/menu.ts"
import { PANE_VIEWS, paneEntry, paneView, type PaneEntry } from "./views.tsx"

const ICON = { size: 16, "stroke-width": 1.5 } as const

type ViewChoice = { readonly kind: "view"; readonly value: string; readonly label: string; readonly view: PaneEntry }
type ThreadChoice = {
  readonly kind: "thread"
  readonly value: string
  readonly label: string
  readonly threadId: number
  readonly status: string
}
type Choice = ViewChoice | ThreadChoice

export function ProjectPane(props: {
  project: ProjectSummary
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onOpenThread: (id: number) => void
}): JSX.Element {
  const tabs = () => projectTabs(props.project.id)
  const open = (): readonly PaneEntry[] =>
    [OVERVIEW, ...tabs().pane].flatMap((id) => {
      const entry = paneEntry(id)
      return entry === undefined ? [] : [entry]
    })
  const view = (): PaneEntry => paneView(tabs().view)
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
    <aside class="flex min-h-0 flex-col">
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
        <ViewMenu project={props.project} current={view().id} onOpenThread={props.onOpenThread} />
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
            {untrack(() =>
              current.render({
                get project() {
                  return props.project
                },
                onOpenThread: props.onOpenThread,
              }),
            )}
          </div>
        )}
      </Show>
    </aside>
  )
}

function ViewMenu(props: { project: ProjectSummary; current: string; onOpenThread: (id: number) => void }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const threads = () => projectThreads(props.project)
  const choices = createMemo<readonly Choice[]>(() => {
    const text = query().trim().toLowerCase()
    const all: Choice[] = [
      ...PANE_VIEWS.map((entry): Choice => ({ kind: "view", value: `view:${entry.id}`, label: entry.label, view: entry })),
      ...threads().map(
        (thread): Choice => ({ kind: "thread", value: `thread:${thread.id}`, label: thread.title, threadId: thread.id, status: thread.status }),
      ),
    ]
    return all.filter((choice) => text === "" || choice.label.toLowerCase().includes(text))
  })
  const collection = createMemo(() =>
    createListCollection<Choice>({ items: [...choices()], itemToValue: (item) => item.value, itemToString: (item) => item.label }),
  )
  const views = () => choices().filter((choice): choice is ViewChoice => choice.kind === "view" && choice.view.id !== "threads")
  const crew = () => choices().filter((choice): choice is ThreadChoice => choice.kind === "thread")
  const all = () => choices().filter((choice): choice is ViewChoice => choice.kind === "view" && choice.view.id === "threads")

  const pick = (value: string): void => {
    const choice = choices().find((entry) => entry.value === value)
    if (choice === undefined) return
    switch (choice.kind) {
      case "view":
        showPaneView(props.project.id, choice.view.id)
        break
      case "thread":
        props.onOpenThread(choice.threadId)
        break
      default: {
        const _exhaustive: never = choice
        return _exhaustive
      }
    }
    setOpen(false)
  }

  return (
    <Popover.Root
      open={open()}
      onOpenChange={(details) => {
        setOpen(details.open)
        if (!details.open) setQuery("")
      }}
      lazyMount
      unmountOnExit
      positioning={{ placement: "bottom-start", gutter: 6 }}
    >
      <Popover.Trigger class={ICON_BUTTON} aria-label="Open a view">
        <Plus {...ICON} />
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content class={`${MENU_CONTENT} w-[320px] p-0`}>
            <Listbox.Root collection={collection()} onSelect={(details) => pick(details.value)} class="flex flex-col">
              <div class="border-b border-line-1 px-3 pb-2 pt-2.5">
                <span class="text-xs text-ink-3">{props.project.name}</span>
                <Listbox.Input
                  autoHighlight
                  autofocus
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search"
                  class="mt-1 h-6 w-full bg-transparent text-sm text-ink outline-none placeholder:text-placeholder"
                />
              </div>
              <Listbox.Content class="flex max-h-[420px] flex-col overflow-y-auto p-1 outline-none">
                <For each={views()}>
                  {(choice) => (
                    <Listbox.Item item={choice} class={MENU_ITEM}>
                      <span class="text-ink-3">
                        <Dynamic component={choice.view.icon} {...ICON} />
                      </span>
                      <Listbox.ItemText class="flex-1 truncate">{choice.label}</Listbox.ItemText>
                      <Show when={choice.view.id === props.current}>
                        <Check {...ICON} class="text-ink-2" />
                      </Show>
                    </Listbox.Item>
                  )}
                </For>
                <Show when={crew().length + all().length > 0}>
                  <Show when={views().length > 0}>
                    <div class={MENU_SEPARATOR} />
                  </Show>
                  <Listbox.ItemGroup>
                    <Listbox.ItemGroupLabel class={MENU_LABEL}>Crew</Listbox.ItemGroupLabel>
                    <For each={crew()}>
                      {(choice) => (
                        <Listbox.Item item={choice} class={MENU_ITEM}>
                          <Signal state={visualState(choice.status)} size={14} class="shrink-0" />
                          <Listbox.ItemText class="flex-1 truncate">{choice.label}</Listbox.ItemText>
                          <ChevronRight size={14} stroke-width={1.5} class="text-icon" />
                        </Listbox.Item>
                      )}
                    </For>
                    <For each={all()}>
                      {(choice) => (
                        <Listbox.Item item={choice} class={MENU_ITEM}>
                          <span class="text-ink-3">
                            <Dynamic component={choice.view.icon} {...ICON} />
                          </span>
                          <Listbox.ItemText class="flex-1">{choice.label}</Listbox.ItemText>
                          <span class="font-mono text-xs text-ink-3">{threads().length}</span>
                        </Listbox.Item>
                      )}
                    </For>
                  </Listbox.ItemGroup>
                </Show>
                <Show when={choices().length === 0}>
                  <span class="px-2 py-1.5 text-sm text-ink-3">No match</span>
                </Show>
              </Listbox.Content>
            </Listbox.Root>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  )
}
