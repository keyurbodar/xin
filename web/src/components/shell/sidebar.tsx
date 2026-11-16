import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Blocks, CalendarClock, Check, ChevronsUpDown, Flower2, HardDrive, Moon, Palette, PanelLeft, Plus, Search, Settings, SquarePen, Sun, X } from "lucide-solid"
import { activeProjects, projectThreads, routeProject, routeThreadId, type ProjectSummary } from "../../state/home.ts"
import { homeCaptains, routeCaptain } from "../../state/captains.ts"
import type { CaptainRow } from "../../lib/captains.ts"
import { owner, ownerName } from "../../state/settings.ts"
import { navigate, route } from "../../lib/router.ts"
import { ago } from "../../lib/format.ts"
import { stagger } from "../../lib/motion.ts"
import { visualState } from "../../lib/status.ts"
import { theme } from "../../lib/theme.ts"
import { loadOnIntent, replayWhenReady, uiSdkReady, warmUiSdk } from "../../lib/ui-sdk-lazy.ts"
import { applyTheme, SlotList, themes } from "../../plugins/slots.tsx"
import { openThreadTab, paneOpen, projectTabs, setSidebarDrawer, showPaneView } from "../../state/tabs.ts"
import { ProjectMark, projectState } from "../chat/project-glyph.tsx"
import { BrandMark } from "../ui/brand-mark.tsx"
import { Signal } from "../ui/signal.tsx"
import { openNewThread } from "./new-thread.tsx"
import { CaptainAvatar } from "../captain/avatar.tsx"
import { openNewCaptain } from "../captain/captain-dialog.tsx"
import { POPUP, POPUP_ITEM, POPUP_LABEL, POPUP_SEPARATOR } from "../ui/surface.ts"
import { ICON_BUTTON } from "./menu.ts"

const ICON = { size: 16, "stroke-width": 1.5 } as const

const THEME_ICONS: Readonly<Record<string, typeof Moon>> = { dark: Moon, light: Sun, rose: Flower2 }

const ROW =
  "im-hover flex h-[var(--h-row)] w-full shrink-0 items-center gap-2 rounded-sm px-2 text-left text-small focus-inset disabled:opacity-50"

const SELECTED = "bg-secondary text-ink"

const SECTION_KEY = "ingle.sidebar.section"

type Section = "threads" | "captains"

const storedSection = (): Section => (localStorage.getItem(SECTION_KEY) === "captains" ? "captains" : "threads")

const SEGMENT =
  "im-focus flex h-full flex-1 cursor-default select-none items-center justify-center rounded-xs text-small text-ink-3 outline-none hover:text-ink-2 data-[checked]:text-ink"

const INDICATOR =
  "im-pill absolute inset-y-0.5 left-0 -z-10 w-[var(--segmented-control-indicator-width,calc(50%-2px))] rounded-xs bg-card shadow-[var(--shadow-ring)]"

/**
 * Where the indicator sits before the segmented control's elements load after mount: the same place they put it,
 * so the swap to their measured values moves nothing.
 */
const INDICATOR_AT: Readonly<Record<Section, string>> = {
  threads: "[translate:var(--segmented-control-indicator-left,2px)_0]",
  captains: "[translate:var(--segmented-control-indicator-left,calc(100%+2px))_0]",
}

export function Sidebar(props: { onSearch: () => void; onCollapse: () => void; drawer: boolean }): JSX.Element {
  onMount(() => void owner.reload())
  const first = (): string | undefined => route().parts[0]
  let projects: HTMLDivElement | undefined
  stagger(() => projects, () => activeProjects().length > 0)

  return (
    <aside class="flex h-full w-[var(--w-sidebar)] shrink-0 flex-col bg-bg">
      <div class="flex h-[var(--h-strip)] shrink-0 items-center gap-1 px-3">
        <BrandMark class="ml-1 h-5 w-5 text-ink" />
        <button type="button" class={`${ICON_BUTTON} ml-auto`} aria-label="Search (⌘K)" title="Search ⌘K" onClick={props.onSearch}>
          <Search {...ICON} />
        </button>
        <button
          type="button"
          class={ICON_BUTTON}
          aria-label={props.drawer ? "Close the sidebar" : "Collapse the sidebar"}
          onClick={props.onCollapse}
        >
          <Show when={props.drawer} fallback={<PanelLeft {...ICON} />}>
            <X {...ICON} />
          </Show>
        </button>
      </div>

      <nav class="flex flex-col gap-px px-2 pt-1">
        <NavRow label="New thread" disabled={routeProject() === undefined} onClick={openNewThread}>
          <SquarePen {...ICON} />
        </NavRow>
        <NavRow
          label="Drive"
          disabled={routeProject() === undefined}
          active={paneOpen() && projectTabs(routeProject()?.id ?? "").view === "files"}
          onClick={() => {
            const project = routeProject()
            if (project === undefined) return
            showPaneView(project.id, "files")
            setSidebarDrawer(false)
          }}
        >
          <HardDrive {...ICON} />
        </NavRow>
        <NavRow label="Automations" active={first() === "automations"} onClick={() => navigate("/automations")}>
          <CalendarClock {...ICON} />
        </NavRow>
        <NavRow label="Extensions" active={first() === "extensions"} onClick={() => navigate("/extensions")}>
          <Blocks {...ICON} />
        </NavRow>
        <NavRow label="Settings" active={first() === "settings"} onClick={() => navigate("/settings/general")}>
          <Settings {...ICON} />
        </NavRow>
      </nav>

      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <SectionHead label="Projects">
          <button type="button" class={ICON_BUTTON} aria-label="New project" onClick={() => navigate("/new")}>
            <Plus {...ICON} />
          </button>
        </SectionHead>
        <div ref={projects} class="flex flex-col gap-px px-2">
          <For each={activeProjects()} fallback={<Empty>No projects yet</Empty>}>
            {(project) => <ProjectRow project={project} />}
          </For>
        </div>

        <LowerSection />
        <SlotList slot="sidebar.section" />
      </div>

      <AccountChip />
    </aside>
  )
}

function NavRow(props: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled === true}
      onClick={() => props.onClick()}
      class={ROW}
      classList={{ [SELECTED]: props.active === true, "text-ink-2": props.active !== true }}
    >
      <span class="text-ink-3">{props.children}</span>
      {props.label}
    </button>
  )
}

function SectionHead(props: { label: string; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex h-9 shrink-0 items-center gap-0.5 pl-4 pr-3 pt-3">
      <span class="mr-auto text-mini font-title text-ink-3">{props.label}</span>
      {props.children}
    </div>
  )
}

function Empty(props: { children: JSX.Element }): JSX.Element {
  return <span class="px-2 py-1 text-small text-ink-3">{props.children}</span>
}

function ProjectRow(props: { project: ProjectSummary }): JSX.Element {
  const current = (): boolean => routeProject()?.id === props.project.id
  const state = () => projectState(props.project)
  return (
    <button
      type="button"
      onClick={() => navigate(`/p/${props.project.slug}`)}
      class={ROW}
      classList={{ [SELECTED]: current(), "text-ink-2": !current() }}
    >
      <span class="grid h-5 w-5 shrink-0 place-items-center rounded-xs border border-line-2 bg-card text-ink-2">
        <ProjectMark slug={props.project.slug} name={props.project.name} goal={props.project.goal} size={13} />
      </span>
      <span class="min-w-0 flex-1 truncate">{props.project.name}</span>
      <Show when={state()}>{(value) => <Signal state={value()} size={14} />}</Show>
    </button>
  )
}

function crewSummary(captain: CaptainRow): string {
  const parts = [`${captain.crew.total} in crew`]
  if (captain.crew.working > 0) parts.push(`${captain.crew.working} working`)
  if (captain.crew.waiting > 0) parts.push(`${captain.crew.waiting} need you`)
  if (captain.crew.failed > 0) parts.push(`${captain.crew.failed} failed`)
  return parts.join(", ")
}

function CaptainRowButton(props: { captain: CaptainRow }): JSX.Element {
  const current = (): boolean => routeCaptain()?.id === props.captain.id
  return (
    <button
      type="button"
      onClick={() => navigate(`/c/${props.captain.alias}`)}
      title={props.captain.description === "" ? crewSummary(props.captain) : `${props.captain.description}\n${crewSummary(props.captain)}`}
      class={ROW}
      classList={{ [SELECTED]: current(), "text-ink-2": !current() }}
    >
      <CaptainAvatar name={props.captain.name} size={20} />
      <span class="min-w-0 flex-1 truncate">{props.captain.name}</span>
      <Show when={props.captain.crew.waiting > 0}>
        <span
          class="im-arrive grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-needs px-1 font-mono text-2xs font-medium text-on-accent"
          aria-label={`${props.captain.crew.waiting} need you`}
        >
          {props.captain.crew.waiting}
        </span>
      </Show>
      <Show when={props.captain.crew.working > 0}>
        <Signal state="working" size={14} />
      </Show>
      <span class="w-4 shrink-0 text-right font-mono text-micro tabular-nums text-ink-3">{props.captain.crew.total}</span>
    </button>
  )
}

/** Threads or Captains, picked on a segmented control and remembered on this device. */
function LowerSection(): JSX.Element {
  const initial = storedSection()
  const [section, setSection] = createSignal<Section>(initial)
  const [searching, setSearching] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const pick = (value: unknown): void => {
    if (value !== "threads" && value !== "captains") return
    setSection(value)
    localStorage.setItem(SECTION_KEY, value)
  }
  onMount(() => warmUiSdk("segmented-control"))
  return (
    <>
      <div class="flex shrink-0 items-center gap-1 px-2 pb-1 pt-4">
        <ui-segmented-control
          aria-label="Sidebar list"
          default-value={initial}
          onFocusIn={() => warmUiSdk("segmented-control")}
          onKeyDown={(event) => {
            if (uiSdkReady("segmented-control") || (event.key !== "Enter" && event.key !== " ")) return
            event.preventDefault()
            if (event.target instanceof HTMLElement) event.target.click()
          }}
          onClick={(event) => replayWhenReady(["segmented-control"], event)}
          on:valuechange={(event) => pick(event.detail.value)}
          class="relative isolate flex h-[var(--h-control-sm)] flex-1 items-center rounded-sm bg-secondary p-0.5"
        >
          <ui-segmented-control-indicator class={`${INDICATOR} ${INDICATOR_AT[initial]}`} />
          <ui-segmented-control-item
            value="threads"
            attr:data-checked={initial === "threads" ? "" : undefined}
            attr:tabindex={initial === "threads" ? "0" : undefined}
            class={SEGMENT}
          >
            Threads
          </ui-segmented-control-item>
          <ui-segmented-control-item
            value="captains"
            attr:data-checked={initial === "captains" ? "" : undefined}
            attr:tabindex={initial === "captains" ? "0" : undefined}
            class={SEGMENT}
          >
            Captains
          </ui-segmented-control-item>
        </ui-segmented-control>
        <Show
          when={section() === "captains"}
          fallback={
            <button
              type="button"
              class={ICON_BUTTON}
              classList={{ "bg-hover text-ink": searching() }}
              aria-label="Search threads"
              aria-pressed={searching()}
              disabled={routeProject() === undefined}
              onClick={() => {
                setSearching((value) => !value)
                setQuery("")
              }}
            >
              <Search {...ICON} />
            </button>
          }
        >
          <button type="button" class={ICON_BUTTON} aria-label="New Captain" onClick={openNewCaptain}>
            <Plus {...ICON} />
          </button>
        </Show>
      </div>
      <Show
        when={section() === "captains"}
        fallback={
          <Show when={routeProject()} fallback={<Empty>Open a project to see its threads</Empty>}>
            {(project) => (
              <ThreadList
                project={project()}
                searching={searching()}
                query={query()}
                onQuery={setQuery}
                onStop={() => {
                  setSearching(false)
                  setQuery("")
                }}
              />
            )}
          </Show>
        }
      >
        <div class="flex flex-col gap-px px-2">
          <For each={homeCaptains()} fallback={<Empty>No Captains yet</Empty>}>
            {(captain) => <CaptainRowButton captain={captain} />}
          </For>
        </div>
      </Show>
    </>
  )
}

function ThreadList(props: {
  project: ProjectSummary
  searching: boolean
  query: string
  onQuery: (query: string) => void
  onStop: () => void
}): JSX.Element {
  const threads = createMemo(() => {
    const text = props.query.trim().toLowerCase()
    return projectThreads(props.project)
      .filter((thread) => text === "" || thread.title.toLowerCase().includes(text))
      .toSorted((left, right) => (right.beatAt ?? 0) - (left.beatAt ?? 0))
  })
  const open = (id: number): void => {
    openThreadTab(props.project.id, id)
    navigate(`/p/${props.project.slug}/t/${id}`)
  }
  let list: HTMLDivElement | undefined
  stagger(() => list, () => threads().length > 0)

  return (
    <>
      <Show when={props.searching}>
        <div class="px-2 pb-1">
          <input
            ref={(element) => queueMicrotask(() => element.focus())}
            value={props.query}
            onInput={(event) => props.onQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") props.onStop()
            }}
            aria-label={`Filter ${props.project.name} threads`}
            placeholder="Filter threads"
            class="h-[var(--h-control-sm)] w-full rounded-sm bg-secondary px-2 text-small text-ink outline-none placeholder:text-placeholder"
          />
        </div>
      </Show>
      <div ref={list} class="flex flex-col gap-px px-2">
        <For each={threads()} fallback={<Empty>{props.query === "" ? "No threads in this project" : "No match"}</Empty>}>
          {(thread) => {
            const current = (): boolean => routeThreadId() === thread.id
            return (
              <button
                type="button"
                onClick={() => open(thread.id)}
                class={ROW}
                classList={{ [SELECTED]: current(), "text-ink-2": !current() }}
                aria-current={current() ? "page" : undefined}
              >
                <Signal state={visualState(thread.status)} size={14} class="shrink-0" />
                <span class="min-w-0 flex-1 truncate">{thread.title}</span>
                <span class="shrink-0 font-mono text-micro tabular-nums text-ink-3">{ago(thread.beatAt)}</span>
              </button>
            )
          }}
        </For>
      </div>
    </>
  )
}

/**
 * The account chip at the foot: the owner's monogram, name and this home's host; it opens the owner menu. The menu's
 * elements load on the chip's first hover, focus or press, and a press that lands first is replayed once they have.
 */
function AccountChip(): JSX.Element {
  const initial = (): string => ownerName().trim().slice(0, 1).toUpperCase() || "O"
  return (
    <div class="shrink-0 border-t border-line-1 p-2">
      <ui-menu
        on:action={(event) => {
          if (event.detail.value === "settings") navigate("/settings/general")
        }}
      >
        <ui-menu-trigger>
          <button
            type="button"
            {...loadOnIntent("menu")}
            class="im-hover im-focus flex h-[var(--h-row-2)] w-full items-center gap-2.5 rounded-sm px-2 text-left data-[open]:bg-hover"
          >
            <span
              aria-hidden="true"
              class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary text-small font-title text-on-primary"
            >
              {initial()}
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-small text-ink">{ownerName()}</span>
              <span class="truncate text-mini text-ink-3">{location.host}</span>
            </span>
            <span class="text-icon">
              <ChevronsUpDown size={14} stroke-width={1.5} />
            </span>
          </button>
        </ui-menu-trigger>
        <ui-menu-content hidden side="top" align="start" side-offset="6" class={`${POPUP} w-[var(--anchor-width)]`}>
          <ui-menu-item value="settings" class={POPUP_ITEM}>
            <span class="text-ink-3">
              <Settings {...ICON} />
            </span>
            Settings
          </ui-menu-item>
          <ui-menu-separator class={POPUP_SEPARATOR} />
          <ui-menu-group>
            <ui-menu-group-label class={POPUP_LABEL}>Theme</ui-menu-group-label>
            <ui-menu-radio-group value={theme()} on:valuechange={(event) => applyTheme(String(event.detail.value))}>
              <For each={themes()}>
                {(entry) => (
                  <ui-menu-radio-item value={entry.id} class={POPUP_ITEM}>
                    <span class="text-ink-3">
                      <Dynamic component={THEME_ICONS[entry.id] ?? Palette} {...ICON} />
                    </span>
                    <span class="flex-1">{entry.label}</span>
                    <ui-menu-item-indicator class="text-ink-2">
                      <Check {...ICON} />
                    </ui-menu-item-indicator>
                  </ui-menu-radio-item>
                )}
              </For>
            </ui-menu-radio-group>
          </ui-menu-group>
        </ui-menu-content>
      </ui-menu>
    </div>
  )
}
