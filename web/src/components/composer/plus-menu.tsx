import { Menu } from "@ark-ui/solid/menu"
import { Brain, ChevronRight, Files, MessagesSquare, Paperclip, Plus, Sparkles, SquareSlash } from "lucide-solid"
import { For, Show, createSignal, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { cmd } from "../../lib/api.ts"
import { listOf, numOf, recordOf, strOf } from "../../lib/parse.ts"
import { prompts, skills } from "../../state/extensions.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { GROUP_LABEL, ITEM, ITEM_ICON, SEPARATOR, SURFACE, TOOL } from "./styles.ts"

type ContextFile = { readonly path: string; readonly name: string; readonly folder: string }
type MemoryNote = { readonly id: number; readonly text: string }

function parseFiles(value: unknown, root: string): readonly ContextFile[] {
  return listOf(value).flatMap((entry) => {
    const path = strOf(recordOf(entry)?.path)
    if (path === undefined) return []
    const relative = path.startsWith(root) ? path.slice(root.length) : path
    const cut = relative.lastIndexOf("/")
    return [{ path, name: relative.slice(cut + 1), folder: cut === -1 ? "" : relative.slice(0, cut) }]
  })
}

function parseNotes(value: unknown): readonly MemoryNote[] {
  return listOf(recordOf(value)?.notes).flatMap((entry) => {
    const record = recordOf(entry)
    const id = numOf(record?.id)
    const text = strOf(record?.text)
    return id === undefined || text === undefined ? [] : [{ id, text }]
  })
}

function allThreads(project: ProjectSummary): readonly ThreadSummary[] {
  const groups = project.threads
  return [...groups.working, ...groups.waiting, ...groups.completed, ...groups.failed, ...groups.cancelled]
}

const SUBMENU = `${SURFACE} max-h-[320px] w-[300px] overflow-y-auto p-1`

function Submenu(props: { label: string; icon: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <Menu.Root positioning={{ placement: "right-start", gutter: 6 }} lazyMount unmountOnExit>
      <Menu.TriggerItem class={ITEM}>
        {props.icon}
        <span class="min-w-0 flex-1 truncate">{props.label}</span>
        <ChevronRight size={14} stroke-width={1.5} class={ITEM_ICON} />
      </Menu.TriggerItem>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class={SUBMENU}>{props.children}</Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}

function Row(props: { value: string; label: string; detail?: string | undefined; onSelect: () => void }): JSX.Element {
  return (
    <Menu.Item value={props.value} valueText={props.label} onSelect={() => props.onSelect()} class={ITEM}>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
      <Show when={props.detail}>
        {(detail) => <span class="max-w-[45%] shrink-0 truncate text-xs text-ink-3">{detail()}</span>}
      </Show>
    </Menu.Item>
  )
}

/** The + menu: attach a file, or put a mention of something this project already has into the draft. */
export function PlusMenu(props: {
  project: ProjectSummary
  disabled: boolean
  onUpload: () => void
  onInsert: (text: string) => void
}): JSX.Element {
  const [files, setFiles] = createSignal<readonly ContextFile[]>([])
  const [notes, setNotes] = createSignal<readonly MemoryNote[]>([])
  const root = (): string => `/projects/${props.project.slug}/`

  const load = (): void => {
    void skills.reload()
    void prompts.reload()
    cmd<unknown>("file.list", { prefix: `/projects/${props.project.slug}` })
      .then((value) => setFiles(parseFiles(value, root()).filter((file) => !file.folder.startsWith("attachments"))))
      .catch(() => setFiles([]))
    cmd<unknown>("memory.list", { scope: `project:${props.project.id}` })
      .then((value) => setNotes(parseNotes(value)))
      .catch(() => setNotes([]))
  }

  const threads = (): readonly ThreadSummary[] => allThreads(props.project)
  const skillRows = () => {
    const state = skills.state()
    return state.kind === "ready" ? state.value : []
  }
  const promptRows = () => {
    const state = prompts.state()
    return state.kind === "ready" ? state.value : []
  }

  return (
    <Menu.Root
      positioning={{ placement: "top-start", gutter: 8 }}
      lazyMount
      unmountOnExit
      onOpenChange={(details) => {
        if (details.open) load()
      }}
    >
      <Menu.Trigger class={`${TOOL} w-[var(--h-control)] justify-center px-0`} aria-label="Add" disabled={props.disabled}>
        <Plus size={16} stroke-width={1.5} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class={`${SURFACE} w-[260px] p-1`}>
            <Menu.Item value="upload" onSelect={() => props.onUpload()} class={ITEM}>
              <Paperclip size={16} stroke-width={1.5} class={ITEM_ICON} />
              <span class="flex-1">Upload attachment</span>
              <span class="text-xs text-ink-3">⌘/</span>
            </Menu.Item>
            <Show
              when={
                threads().length + files().length + skillRows().length + promptRows().length + notes().length > 0
              }
            >
              <Menu.Separator class={SEPARATOR} />
              <div class={GROUP_LABEL}>Add context</div>
            </Show>
            <Show when={threads().length > 0}>
              <Submenu label="Threads" icon={<MessagesSquare size={16} stroke-width={1.5} class={ITEM_ICON} />}>
                <For each={threads()}>
                  {(thread) => (
                    <Row
                      value={`thread:${thread.id}`}
                      label={thread.title}
                      detail={thread.status}
                      onSelect={() => props.onInsert(`@thread:${thread.id} `)}
                    />
                  )}
                </For>
              </Submenu>
            </Show>
            <Show when={files().length > 0}>
              <Submenu label="Files" icon={<Files size={16} stroke-width={1.5} class={ITEM_ICON} />}>
                <For each={files()}>
                  {(file) => (
                    <Row
                      value={`file:${file.path}`}
                      label={file.name}
                      detail={file.folder}
                      onSelect={() => props.onInsert(`@${file.path} `)}
                    />
                  )}
                </For>
              </Submenu>
            </Show>
            <Show when={skillRows().length > 0}>
              <Submenu label="Skills" icon={<Sparkles size={16} stroke-width={1.5} class={ITEM_ICON} />}>
                <For each={skillRows()}>
                  {(skill) => (
                    <Row
                      value={`skill:${skill.name}`}
                      label={skill.name}
                      detail={skill.description}
                      onSelect={() => props.onInsert(`@skill:${skill.name} `)}
                    />
                  )}
                </For>
              </Submenu>
            </Show>
            <Show when={promptRows().length > 0}>
              <Submenu label="Prompts" icon={<SquareSlash size={16} stroke-width={1.5} class={ITEM_ICON} />}>
                <For each={promptRows()}>
                  {(prompt) => (
                    <Row
                      value={`prompt:${prompt.name}`}
                      label={`/${prompt.name}`}
                      detail={prompt.description}
                      onSelect={() => props.onInsert(`/${prompt.name} `)}
                    />
                  )}
                </For>
              </Submenu>
            </Show>
            <Show when={notes().length > 0}>
              <Submenu label="Memory" icon={<Brain size={16} stroke-width={1.5} class={ITEM_ICON} />}>
                <For each={notes()}>
                  {(note) => (
                    <Row value={`memory:${note.id}`} label={note.text} onSelect={() => props.onInsert(`> ${note.text}\n`)} />
                  )}
                </For>
              </Submenu>
            </Show>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}
