import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import { Menu } from "@ark-ui/solid/menu"
import { Blocks, CalendarClock, Check, ChevronsUpDown, Flower2, Moon, PanelLeft, Plus, Search, Settings, SquarePen, Sun, X } from "lucide-solid"
import { activeProjects, projectThreads, routeProject, routeThreadId, type ProjectSummary } from "../../state/home.ts"
import { owner, ownerName } from "../../state/settings.ts"
import { navigate, route } from "../../lib/router.ts"
import { ago } from "../../lib/format.ts"
import { stagger } from "../../lib/motion.ts"
import { visualState } from "../../lib/status.ts"
import { setTheme, theme, themeOf } from "../../lib/theme.ts"
import { openThreadTab } from "../../state/tabs.ts"
import { ProjectMark, projectState } from "../chat/project-glyph.tsx"
import { BrandMark } from "../ui/brand-mark.tsx"
import { Signal } from "../ui/signal.tsx"
import { openNewThread } from "./new-thread.tsx"
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM, MENU_LABEL, MENU_SEPARATOR } from "./menu.ts"

const ICON = { size: 16, "stroke-width": 1.5 } as const

const THEMES = [
  { id: "dark", label: "Dark", icon: Moon },
  { id: "light", label: "Light", icon: Sun },
  { id: "rose", label: "Rose", icon: Flower2 },
] as const

const ROW =
  "flex h-[var(--h-row)] w-full shrink-0 items-center gap-2.5 rounded-sm px-2 text-left text-sm im-hover"

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
        <NavRow label="Schedules" active={first() === "schedules"} onClick={() => navigate("/schedules")}>
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
          <For each={activeProjects()} fallback={<span class="px-2 py-1 text-sm text-ink-3">No projects yet</span>}>
            {(project) => <ProjectRow project={project} />}
          </For>
        </div>

        <Show when={routeProject()}>{(project) => <ThreadList project={project()} />}</Show>
      </div>

      <OwnerMenu />
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
      class={`${ROW} disabled:opacity-50`}
      classList={{ "bg-hover text-ink": props.active === true, "text-ink-2": props.active !== true }}
    >
      <span class="text-ink-3">{props.children}</span>
      {props.label}
    </button>
  )
}

function SectionHead(props: { label: string; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex h-9 shrink-0 items-center gap-0.5 pl-4 pr-3 pt-3">
      <span class="mr-auto text-xs text-ink-3">{props.label}</span>
      {props.children}
    </div>
  )
}

function ProjectRow(props: { project: ProjectSummary }): JSX.Element {
  const current = (): boolean => routeProject()?.id === props.project.id
  const state = () => projectState(props.project)
  return (
    <button
      type="button"
      onClick={() => navigate(`/p/${props.project.slug}`)}
      class={ROW}
      classList={{ "bg-hover text-ink": current(), "text-ink-2": !current() }}
    >
      <span class="grid h-5 w-5 shrink-0 place-items-center rounded-xs border border-line-2 bg-card text-ink-2">
        <ProjectMark slug={props.project.slug} name={props.project.name} goal={props.project.goal} size={13} />
      </span>
      <span class="min-w-0 flex-1 truncate">{props.project.name}</span>
      <Show when={state()}>{(value) => <Signal state={value()} size={14} />}</Show>
    </button>
  )
}

function ThreadList(props: { project: ProjectSummary }): JSX.Element {
  const [searching, setSearching] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const threads = createMemo(() => {
    const text = query().trim().toLowerCase()
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
      <SectionHead label="Threads">
        <button
          type="button"
          class={ICON_BUTTON}
          classList={{ "bg-hover text-ink": searching() }}
          aria-label="Search threads"
          aria-pressed={searching()}
          onClick={() => {
            setSearching((value) => !value)
            setQuery("")
          }}
        >
          <Search {...ICON} />
        </button>
      </SectionHead>
      <Show when={searching()}>
        <div class="px-2 pb-1">
          <input
            ref={(element) => queueMicrotask(() => element.focus())}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              setSearching(false)
              setQuery("")
            }}
            placeholder="Filter threads"
            class="h-[var(--h-control-sm)] w-full rounded-sm bg-secondary px-2 text-sm text-ink outline-none placeholder:text-placeholder"
          />
        </div>
      </Show>
      <div ref={list} class="flex flex-col gap-px px-2">
        <For
          each={threads()}
          fallback={
            <span class="px-2 py-1 text-sm text-ink-3">{query() === "" ? "No threads in this project" : "No match"}</span>
          }
        >
          {(thread) => {
            const current = (): boolean => routeThreadId() === thread.id
            return (
              <button
                type="button"
                onClick={() => open(thread.id)}
                class={ROW}
                classList={{ "bg-hover text-ink": current(), "text-ink-2": !current() }}
              >
                <Signal state={visualState(thread.status)} size={14} class="shrink-0" />
                <span class="min-w-0 flex-1 truncate">{thread.title}</span>
                <span class="shrink-0 font-mono text-2xs text-ink-3">{ago(thread.beatAt)}</span>
              </button>
            )
          }}
        </For>
      </div>
    </>
  )
}

function OwnerMenu(): JSX.Element {
  const initial = (): string => ownerName().trim().slice(0, 1).toUpperCase() || "O"
  return (
    <div class="shrink-0 border-t border-line-1 p-2">
      <Menu.Root
        lazyMount
        unmountOnExit
        positioning={{ placement: "top-start", sameWidth: true, gutter: 6 }}
        onSelect={(details) => {
          if (details.value === "settings") navigate("/settings/general")
        }}
      >
        <Menu.Trigger class={`${ROW} h-[var(--h-control)] text-ink data-[state=open]:bg-hover`}>
          <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-medium text-on-primary">
            {initial()}
          </span>
          <span class="min-w-0 flex-1 truncate">{ownerName()}</span>
          <span class="text-icon">
            <ChevronsUpDown size={14} stroke-width={1.5} />
          </span>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content class={MENU_CONTENT}>
              <Menu.Item value="settings" class={MENU_ITEM}>
                <span class="text-ink-3">
                  <Settings {...ICON} />
                </span>
                Settings
              </Menu.Item>
              <Menu.Separator class={MENU_SEPARATOR} />
              <Menu.RadioItemGroup value={theme()} onValueChange={(details) => setTheme(themeOf(details.value))}>
                <Menu.ItemGroupLabel class={MENU_LABEL}>Theme</Menu.ItemGroupLabel>
                <For each={THEMES}>
                  {(entry) => (
                    <Menu.RadioItem value={entry.id} closeOnSelect={false} class={MENU_ITEM}>
                      <span class="text-ink-3">
                        <Dynamic component={entry.icon} {...ICON} />
                      </span>
                      <Menu.ItemText class="flex-1">{entry.label}</Menu.ItemText>
                      <Menu.ItemIndicator class="text-ink-2">
                        <Check {...ICON} />
                      </Menu.ItemIndicator>
                    </Menu.RadioItem>
                  )}
                </For>
              </Menu.RadioItemGroup>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </div>
  )
}
