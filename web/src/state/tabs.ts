import { createSignal, untrack } from "solid-js"
import { isRecord, listOf, numOf, recordOf, strOf } from "../lib/parse.ts"
import { closeTabs, forgetTabs, moveTab, openTab, openTabs, reopenTabs, type TabOrder } from "../lib/tab-order.ts"

/** A pane view id from the view registry in components/pane/views.tsx; "overview" is always open. */
export type PaneView = string

export const OVERVIEW: PaneView = "overview"

/** `threads` is the tab order with closed placeholders in it; `closed` lives in memory only, so a reload drops them. */
type ProjectTabs = {
  readonly threads: readonly number[]
  readonly closed: readonly number[]
  readonly pane: readonly PaneView[]
  readonly view: PaneView
}

type Layout = {
  readonly projects: Readonly<Record<string, ProjectTabs>>
  readonly paneOpen: boolean
  readonly sidebarHidden: boolean
}

const KEY = "ingle.tabs"
const EMPTY: ProjectTabs = { threads: [], closed: [], pane: [], view: OVERVIEW }

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
  return { threads: [...new Set(threads)], closed: [], pane: [...new Set(pane)], view: pane.includes(view) ? view : OVERVIEW }
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
  const projects = Object.fromEntries(
    Object.entries(next.projects).map(([id, tabs]) => {
      const { closed: _closed, ...stored } = tabs
      return [id, { ...stored, threads: openTabs(orderOf(tabs)) }]
    }),
  )
  localStorage.setItem(KEY, JSON.stringify({ ...next, projects }))
}

const orderOf = (tabs: ProjectTabs): TabOrder => ({ order: tabs.threads, closed: tabs.closed })

function updateOrder(projectId: string, change: (current: TabOrder) => TabOrder): void {
  updateProject(projectId, (tabs) => {
    const next = change(orderOf(tabs))
    return { ...tabs, threads: next.order, closed: next.closed }
  })
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

/** The open thread tabs in order, without closed placeholders. */
export function openThreadTabs(projectId: string): readonly number[] {
  return openTabs(orderOf(projectTabs(projectId)))
}

export function openThreadTab(projectId: string, threadId: number): void {
  updateOrder(projectId, (tabs) => openTab(tabs, threadId))
}

export function closeThreadTabs(projectId: string, threadIds: readonly number[]): void {
  updateOrder(projectId, (tabs) => closeTabs(tabs, threadIds))
}

export function reopenThreadTabs(projectId: string, threadIds: readonly number[]): void {
  updateOrder(projectId, (tabs) => reopenTabs(tabs, threadIds))
}

/** Ends the undo window of closed tabs: their placeholders leave the order. */
export function forgetThreadTabs(projectId: string, threadIds: readonly number[]): void {
  updateOrder(projectId, (tabs) => forgetTabs(tabs, threadIds))
}

export function moveThreadTab(projectId: string, threadId: number, index: number): void {
  updateOrder(projectId, (tabs) => moveTab(tabs, threadId, index))
}

/** Drops tabs whose thread the home no longer lists, so a deleted thread never leaves a dead tab behind. */
export function pruneThreadTabs(projectId: string, live: ReadonlySet<number>): void {
  updateProject(projectId, (current) => ({
    ...current,
    threads: current.threads.filter((id) => live.has(id)),
    closed: current.closed.filter((id) => live.has(id)),
  }))
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
