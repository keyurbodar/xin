import { createSignal, untrack } from "solid-js"
import { isRecord, listOf, numOf, recordOf, strOf } from "../lib/parse.ts"
import { reinsert, type RemovedTab } from "../lib/tab-order.ts"

/** A pane view id from the view registry in components/pane/views.tsx; "overview" is always open. */
export type PaneView = string

export const OVERVIEW: PaneView = "overview"

type ProjectTabs = {
  readonly threads: readonly number[]
  readonly pane: readonly PaneView[]
  readonly view: PaneView
}

type Layout = {
  readonly projects: Readonly<Record<string, ProjectTabs>>
  readonly paneOpen: boolean
  readonly sidebarHidden: boolean
}

const KEY = "ingle.tabs"
const EMPTY: ProjectTabs = { threads: [], pane: [], view: OVERVIEW }

function projectTabsOf(value: unknown): ProjectTabs {
  const record = recordOf(value)
  if (record === undefined) return EMPTY
  const threads = listOf(record.threads).flatMap((entry) => {
    const id = numOf(entry)
    return id === undefined ? [] : [id]
  })
  const pane = listOf(record.pane).flatMap((entry) => {
    const view = strOf(entry)
    return view === undefined || view === OVERVIEW ? [] : [view]
  })
  const view = strOf(record.view) ?? OVERVIEW
  return { threads: [...new Set(threads)], pane: [...new Set(pane)], view: pane.includes(view) ? view : OVERVIEW }
}

function read(): Layout {
  let stored: unknown
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}")
  } catch {
    stored = {}
  }
  const record = isRecord(stored) ? stored : {}
  const projects = Object.fromEntries(
    Object.entries(recordOf(record.projects) ?? {}).map(([id, value]) => [id, projectTabsOf(value)]),
  )
  return { projects, paneOpen: record.paneOpen !== false, sidebarHidden: record.sidebarHidden === true }
}

const [layout, setLayout] = createSignal<Layout>(read())

function update(change: (current: Layout) => Layout): void {
  const current = untrack(layout)
  const next = change(current)
  if (JSON.stringify(next) === JSON.stringify(current)) return
  setLayout(next)
  localStorage.setItem(KEY, JSON.stringify(next))
}

function updateProject(projectId: string, change: (current: ProjectTabs) => ProjectTabs): void {
  update((current) => ({
    ...current,
    projects: { ...current.projects, [projectId]: change(current.projects[projectId] ?? EMPTY) },
  }))
}

export function projectTabs(projectId: string): ProjectTabs {
  return layout().projects[projectId] ?? EMPTY
}

export function openThreadTab(projectId: string, threadId: number): void {
  updateProject(projectId, (tabs) => (tabs.threads.includes(threadId) ? tabs : { ...tabs, threads: [...tabs.threads, threadId] }))
}

export function closeThreadTabs(projectId: string, threadIds: readonly number[]): void {
  updateProject(projectId, (tabs) => ({ ...tabs, threads: tabs.threads.filter((id) => !threadIds.includes(id)) }))
}

/** Reopens closed tabs at their old indexes; every other tab stays where it is now. */
export function reopenThreadTabs(projectId: string, removed: readonly RemovedTab[]): void {
  updateProject(projectId, (tabs) => ({ ...tabs, threads: reinsert(tabs.threads, removed) }))
}

export function moveThreadTab(projectId: string, threadId: number, index: number): void {
  updateProject(projectId, (tabs) => {
    const rest = tabs.threads.filter((id) => id !== threadId)
    const at = Math.max(0, Math.min(rest.length, index))
    return { ...tabs, threads: [...rest.slice(0, at), threadId, ...rest.slice(at)] }
  })
}

/** Drops tabs whose thread the home no longer lists, so a deleted thread never leaves a dead tab behind. */
export function pruneThreadTabs(projectId: string, live: ReadonlySet<number>): void {
  updateProject(projectId, (current) => ({ ...current, threads: current.threads.filter((id) => live.has(id)) }))
}

export function showPaneView(projectId: string, view: PaneView): void {
  updateProject(projectId, (tabs) => ({
    ...tabs,
    view,
    pane: view === OVERVIEW || tabs.pane.includes(view) ? tabs.pane : [...tabs.pane, view],
  }))
  update((current) => ({ ...current, paneOpen: true }))
}

export function closePaneView(projectId: string, view: PaneView): void {
  updateProject(projectId, (tabs) => {
    const index = tabs.pane.indexOf(view)
    const pane = tabs.pane.filter((entry) => entry !== view)
    if (tabs.view !== view) return { ...tabs, pane }
    return { ...tabs, pane, view: pane[index - 1] ?? OVERVIEW }
  })
}

export const paneOpen = (): boolean => layout().paneOpen

export function setPaneOpen(open: boolean): void {
  update((current) => ({ ...current, paneOpen: open }))
}

export const sidebarHidden = (): boolean => layout().sidebarHidden

export function setSidebarHidden(hidden: boolean): void {
  update((current) => ({ ...current, sidebarHidden: hidden }))
}

const [drawer, setDrawer] = createSignal(false)

export const sidebarDrawer = drawer
export const setSidebarDrawer = setDrawer

const wideQuery = window.matchMedia("(min-width: 1024px)")
const [wide, setWide] = createSignal(wideQuery.matches)
wideQuery.addEventListener("change", (event) => setWide(event.matches))

/** Below 1024px the sidebar is a drawer; above it, it docks unless the person collapsed it. */
export const wideShell = wide

export function toggleSidebar(): void {
  if (wide()) setSidebarHidden(!sidebarHidden())
  else setDrawer(!drawer())
}
