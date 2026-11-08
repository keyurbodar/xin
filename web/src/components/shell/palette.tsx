import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { activeProjects } from "../../state/home.ts"
import { navigate } from "../../lib/router.ts"
import { StatusGlyph } from "../ui/status-glyph.tsx"
import type { VisualState } from "../../lib/status.ts"
import { Icon, type IconName } from "../ui/icon.tsx"

type Kind = "thread" | "project" | "page" | "action"

type Item = {
  readonly id: string
  readonly kind: Kind
  readonly title: string
  readonly meta: string
  readonly state?: VisualState
  readonly icon?: IconName
  readonly open: () => void
}

const PAGES: readonly { title: string; meta: string; icon: IconName; path: string }[] = [
  { title: "Home", meta: "Page", icon: "home", path: "/" },
  { title: "Inbox", meta: "Page", icon: "inbox", path: "/inbox" },
  { title: "Extensions", meta: "Page", icon: "grid", path: "/extensions" },
  { title: "Schedules", meta: "Page", icon: "calendar", path: "/schedules" },
  { title: "Settings", meta: "Page", icon: "settings", path: "/settings/general" },
]

const ACTIONS: readonly { title: string; meta: string; icon: IconName; path: string }[] = [
  { title: "New project", meta: "Action", icon: "plus", path: "/new" },
  { title: "Open Inbox", meta: "Action", icon: "inbox", path: "/inbox" },
]

const TABS: readonly { id: Kind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "thread", label: "Threads" },
  { id: "project", label: "Projects" },
  { id: "page", label: "Pages" },
  { id: "action", label: "Actions" },
]

const GROUP_LABEL: Readonly<Record<Kind, string>> = {
  thread: "Threads",
  project: "Projects",
  page: "Pages",
  action: "Actions",
}

const RANK: Readonly<Record<string, number>> = { waiting: 0, failed: 1, working: 2, queued: 3, paused: 4, done: 5, cancelled: 6 }

function items(): readonly Item[] {
  const rows: Item[] = []
  for (const project of activeProjects()) {
    rows.push({
      id: `project:${project.id}`,
      kind: "project",
      title: project.name,
      meta: project.goal ?? "Project",
      icon: "folder",
      open: () => navigate(`/p/${project.slug}`),
    })
    const states: readonly [VisualState, readonly { id: number; title: string; statusLine?: string }[]][] = [
      ["waiting", project.threads.waiting],
      ["failed", project.threads.failed],
      ["working", project.threads.working],
      ["done", project.threads.completed],
      ["cancelled", project.threads.cancelled],
    ]
    for (const [state, list] of states) {
      for (const thread of list) {
        rows.push({
          id: `thread:${project.id}:${thread.id}`,
          kind: "thread",
          title: thread.title,
          meta: `${project.name}${thread.statusLine === undefined ? "" : ` · ${thread.statusLine}`}`,
          state,
          open: () => navigate(`/p/${project.slug}`),
        })
      }
    }
  }
  for (const page of PAGES) {
    rows.push({ id: `page:${page.title}`, kind: "page", title: page.title, meta: page.meta, icon: page.icon, open: () => navigate(page.path) })
  }
  for (const action of ACTIONS) {
    rows.push({
      id: `action:${action.title}`,
      kind: "action",
      title: action.title,
      meta: action.meta,
      icon: action.icon,
      open: () => navigate(action.path),
    })
  }
  return rows
}

function rank(item: Item): number {
  const byState = item.state === undefined ? 7 : (RANK[item.state] ?? 7)
  return item.kind === "thread" ? byState : byState + 10
}

function matches(item: Item, query: string): boolean {
  return item.title.toLowerCase().includes(query) || item.meta.toLowerCase().includes(query)
}

function Marked(props: { text: string; query: string }): JSX.Element {
  const parts = createMemo(() => {
    const query = props.query.trim().toLowerCase()
    if (query === "") return [{ text: props.text, hit: false }]
    const out: { text: string; hit: boolean }[] = []
    const lower = props.text.toLowerCase()
    let at = 0
    let found = lower.indexOf(query, at)
    while (found !== -1) {
      if (found > at) out.push({ text: props.text.slice(at, found), hit: false })
      out.push({ text: props.text.slice(found, found + query.length), hit: true })
      at = found + query.length
      found = lower.indexOf(query, at)
    }
    if (at < props.text.length) out.push({ text: props.text.slice(at), hit: false })
    return out
  })

  return (
    <For each={parts()}>
      {(part) => (
        <Show when={part.hit} fallback={<>{part.text}</>}>
          <span class="text-fg underline decoration-accent underline-offset-[3px]">{part.text}</span>
        </Show>
      )}
    </For>
  )
}

export function CommandPalette(props: { open: boolean; onClose: () => void }): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const [tab, setTab] = createSignal<Kind | "all">("all")
  let input!: HTMLInputElement

  const results = createMemo(() => {
    const text = query().trim().toLowerCase()
    const filter = tab()
    const all = items().filter((item) => (filter === "all" || item.kind === filter) && (text === "" || matches(item, text)))
    return all.sort((left, right) => rank(left) - rank(right))
  })

  const groups = createMemo(() => {
    const flat = results()
    const order: readonly Kind[] = ["thread", "project", "page", "action"]
    return order
      .map((kind) => ({ kind, items: flat.filter((item) => item.kind === kind) }))
      .filter((group) => group.items.length > 0)
  })

  const position = (item: Item): number => results().findIndex((entry) => entry.id === item.id)

  const active = (): Item | undefined => results()[cursor()]

  const choose = (item: Item | undefined): void => {
    if (item === undefined) return
    item.open()
    close()
  }

  const close = (): void => {
    setQuery("")
    setCursor(0)
    setTab("all")
    props.onClose()
  }

  createEffect(() => {
    if (!props.open) return
    queueMicrotask(() => input.focus())
  })

  createEffect(() => {
    query()
    tab()
    setCursor(0)
  })

  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!props.open) return
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setCursor((value) => Math.min(results().length - 1, value + 1))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setCursor((value) => Math.max(0, value - 1))
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        choose(active())
        return
      }
      if (event.key === "Tab") {
        event.preventDefault()
        const index = TABS.findIndex((entry) => entry.id === tab())
        const next = TABS[(index + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length]
        if (next !== undefined) setTab(next.id)
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex justify-center bg-[var(--scrim)] backdrop-blur-[6px] backdrop-saturate-[0.7]"
        onMouseDown={close}
      >
        <div
          class="enter mt-[150px] h-fit w-[560px] overflow-hidden rounded-[16px] border border-line-inner bg-overlay shadow-[var(--shadow-float)]"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
        >
          <div class="flex h-14 items-center gap-2.5 border-b border-line px-4">
            <Icon name="search" size={16} class="text-fg-3" />
            <input
              ref={input}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search projects, threads, pages and actions"
              class="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-4"
            />
            <span class="kbd">esc</span>
          </div>

          <div class="flex gap-0.5 border-b border-line px-2.5 py-1.5">
            <For each={TABS}>
              {(entry) => (
                <button
                  type="button"
                  onClick={() => setTab(entry.id)}
                  class="flex h-7 items-center rounded-[8px] px-2.5 text-[12.5px]"
                  classList={{ "bg-selected text-fg": tab() === entry.id, "text-fg-3 hover:text-fg-2": tab() !== entry.id }}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>

          <div class="max-h-[420px] overflow-y-auto pb-1.5">
            <Show when={results().length > 0} fallback={<div class="px-4 py-6 text-center text-[13px] text-fg-3">Nothing matches that.</div>}>
              <For each={groups()}>
                {(group) => (
                  <>
                    <div class="label px-4 pb-1 pt-2.5">{GROUP_LABEL[group.kind]}</div>
                    <For each={group.items}>
                      {(item) => (
                        <button
                          type="button"
                          onMouseEnter={() => setCursor(position(item))}
                          onClick={() => choose(item)}
                          class="mx-1.5 flex h-9 w-[calc(100%-12px)] items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13.5px]"
                          classList={{
                            "bg-selected text-fg": cursor() === position(item),
                            "text-fg-2": cursor() !== position(item),
                          }}
                        >
                          <Show
                            when={item.state !== undefined}
                            fallback={
                              <Icon
                                name={item.icon ?? "file"}
                                size={14}
                                class={cursor() === position(item) ? "text-fg" : "text-fg-3"}
                              />
                            }
                          >
                            <StatusGlyph state={item.state ?? "queued"} size={16} />
                          </Show>
                          <span class="min-w-0 flex-1 truncate">
                            <Marked text={item.title} query={query()} />
                          </span>
                          <span class="mono-meta ml-auto shrink-0 pl-3">{item.meta}</span>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </Show>
          </div>

          <div class="flex h-9 items-center gap-3.5 border-t border-line px-4 text-[11px] text-fg-4">
            <span class="flex items-center gap-1.5">
              <span class="kbd">↑</span>
              <span class="kbd">↓</span>move
            </span>
            <span class="flex items-center gap-1.5">
              <span class="kbd">↵</span>open
            </span>
            <span class="flex items-center gap-1.5">
              <span class="kbd">tab</span>next tab
            </span>
            <span class="ml-auto">{results().length} results</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
