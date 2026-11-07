import { For, Show, type JSX } from "solid-js"
import { activeProjects, type ProjectSummary } from "../../state/home.ts"
import { navigate, route } from "../../lib/router.ts"
import { Icon, type IconName } from "../ui/icon.tsx"

const PROJECT_ICONS: readonly IconName[] = ["users", "file", "folder", "layers", "grid", "brain"]

function projectIcon(slug: string): IconName {
  let hash = 0
  for (const char of slug) hash = (hash + char.charCodeAt(0)) % PROJECT_ICONS.length
  return PROJECT_ICONS[hash] ?? "folder"
}

function summary(project: ProjectSummary): string {
  const waiting = project.openRequests + project.threads.waiting.length
  const working = project.threads.working.length
  const failed = project.threads.failed.length
  const parts: string[] = []
  if (waiting > 0) parts.push(`${waiting} waiting`)
  if (working > 0) parts.push(`${working} working`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (parts.length === 0) parts.push(project.threads.completed.length > 0 ? `Idle · ${project.threads.completed.length} reports` : "Idle")
  return parts.join(" · ")
}

export function Sidebar(): JSX.Element {
  const onProject = (slug: string): boolean => route().parts[0] === "p" && route().parts[1] === slug
  const needsYou = (project: ProjectSummary): boolean =>
    project.openRequests > 0 || project.threads.waiting.length > 0 || project.threads.failed.length > 0

  return (
    <aside class="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-surface p-2">
      <button
        type="button"
        onClick={() => navigate("/search")}
        class="flex h-9 items-center gap-2.5 rounded-[2px] px-2 text-left transition-none hover:bg-hover"
      >
        <IconBox name="search" />
        <span class="text-[12.5px] text-fg">Search</span>
        <span class="kbd ml-auto">⌘K</span>
      </button>

      <nav class="flex flex-col">
        <NavRow icon="home" label="Home" active={route().path === "/"} onClick={() => navigate("/")} />
        <NavRow
          icon="inbox"
          label="Inbox"
          active={route().parts[0] === "inbox"}
          onClick={() => navigate("/inbox")}
          dot={activeProjects().some(needsYou)}
        />
        <NavRow
          icon="grid"
          label="Extensions"
          active={route().parts[0] === "extensions"}
          onClick={() => navigate("/extensions")}
        />
      </nav>

      <div class="flex items-center px-2 pb-1.5 pt-4">
        <span class="label">Projects</span>
        <button
          type="button"
          class="ml-auto text-fg-4 transition-none hover:text-fg-2"
          onClick={() => navigate("/new")}
          aria-label="New project"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <For each={activeProjects()}>
          {(project) => (
            <button
              type="button"
              onClick={() => navigate(`/p/${project.slug}`)}
              class="flex h-9 w-full shrink-0 items-center gap-2.5 rounded-[2px] px-2 text-left transition-none hover:bg-hover"
              classList={{ "bg-selected hover:bg-selected": onProject(project.slug) }}
            >
              <span
                class="grid h-6 w-6 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-raised"
                classList={{ "text-fg": onProject(project.slug), "text-fg-2": !onProject(project.slug) }}
              >
                <Icon name={projectIcon(project.slug)} size={14} />
              </span>
              <span class="min-w-0 flex-1 leading-[1.2]">
                <span class="block truncate text-[12.5px]" classList={{ "text-fg": onProject(project.slug), "text-fg-2": !onProject(project.slug) }}>
                  {project.name}
                </span>
                <span class="block truncate text-[11.5px] text-fg-3">{summary(project)}</span>
              </span>
              <Show when={needsYou(project)}>
                <span class="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-accent" />
              </Show>
            </button>
          )}
        </For>
      </div>

      <div class="mt-auto flex flex-col">
        <button
          type="button"
          onClick={() => navigate("/settings/general")}
          class="flex h-9 w-full items-center gap-2.5 rounded-[2px] px-2 text-left transition-none hover:bg-hover"
        >
          <IconBox name="settings" />
          <span class="text-[12.5px] text-fg-2">Settings</span>
        </button>
        <div class="flex h-9 items-center gap-2.5 px-2">
          <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-line-inner text-[11px] text-fg-2">O</span>
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">Owner</span>
          <span class="mono-meta">Owner</span>
        </div>
      </div>
    </aside>
  )
}

function IconBox(props: { name: IconName }): JSX.Element {
  return (
    <span class="grid h-6 w-6 shrink-0 place-items-center text-fg-3">
      <Icon name={props.name} size={16} />
    </span>
  )
}

function NavRow(props: {
  icon: IconName
  label: string
  active: boolean
  onClick: () => void
  dot?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex h-9 items-center gap-2.5 rounded-[2px] px-2 text-left transition-none hover:bg-hover"
      classList={{ "bg-selected hover:bg-selected": props.active }}
    >
      <IconBox name={props.icon} />
      <span class="text-[12.5px]" classList={{ "text-fg": props.active, "text-fg-2": !props.active }}>
        {props.label}
      </span>
      <Show when={props.dot === true}>
        <span class="ml-auto h-1.5 w-1.5 rounded-[1px] bg-accent" />
      </Show>
    </button>
  )
}
