import "@ui-sdk/web/input"
import "@ui-sdk/web/menu"
import "@ui-sdk/web/tree"
import { createEffect, createSignal, For, on, onMount, Show, untrack, type JSX } from "solid-js"
import { BookText, ChevronRight, Link2, LoaderCircle, RotateCw, Sparkles } from "lucide-solid"
import { folderOf, renameProblem, reservedOf, SKILLS_FOLDER, type DriveRow } from "../../lib/drive.ts"
import { fileIconUrl } from "../../lib/file-icons.ts"
import { theme } from "../../lib/theme.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM, POPUP_SEPARATOR } from "../ui/surface.ts"

const ROW =
  "flex h-[var(--h-row)] cursor-default select-none items-center gap-1.5 rounded-sm pl-[calc((var(--tree-level)-1)*14px+4px)] pr-2 text-small text-ink-2 hover:bg-hover data-[selected]:bg-secondary data-[selected]:text-ink [ui-tree-item:focus-visible>&]:shadow-[inset_2px_0_0_var(--color-primary)]"

const GROUP =
  "relative data-[expanded]:block before:pointer-events-none before:absolute before:inset-y-0 before:left-[calc((var(--tree-level)-1)*14px+11.5px)] before:w-px before:bg-line-1"

type Target = { readonly path: string; readonly folder: boolean }

export function FileIcon(props: { name: string; folder: boolean }): JSX.Element {
  return (
    <img
      src={fileIconUrl(props.name, props.folder, theme() === "light" ? "light" : "dark")}
      alt=""
      width={16}
      height={16}
      draggable={false}
      class="size-4 shrink-0"
    />
  )
}

function RowIcon(props: { row: DriveRow }): JSX.Element {
  const row = props.row
  if (row.kind === "folder") {
    return (
      <Show when={row.path === `${SKILLS_FOLDER}/`} fallback={<FileIcon name={row.name} folder />}>
        <Sparkles size={16} stroke-width={1.5} class="shrink-0 text-ink-3" />
      </Show>
    )
  }
  const reserved = reservedOf(row.entry.path)
  if (reserved === undefined) return <FileIcon name={row.name} folder={false} />
  return reserved.kind === "instructions" ? (
    <BookText size={16} stroke-width={1.5} class="shrink-0 text-ink-3" />
  ) : (
    <Sparkles size={16} stroke-width={1.5} class="shrink-0 text-ink-3" />
  )
}

const valueOf = (row: DriveRow): string => (row.kind === "folder" ? row.path : row.entry.path)

/**
 * A drive scope's files as a tree, after zeron's file tree: folders load their rows the first time they open, a file
 * opens on press or Enter, F2 renames in place, and a right-click or Shift+F10 opens the row's menu.
 */
export function DriveTree(props: {
  label: string
  rows: readonly DriveRow[]
  load: (folder: string) => Promise<readonly DriveRow[]>
  shares: Readonly<Record<string, string>>
  onOpen: (path: string) => void
  onRename: (from: string, to: string) => Promise<void>
  onMove: (path: string) => void
  onDelete: (path: string) => void
}): JSX.Element {
  let host: HTMLDivElement | undefined
  const tree = (): HTMLElementTagNameMap["ui-tree"] | null | undefined => host?.querySelector("ui-tree")
  const [children, setChildren] = createSignal<ReadonlyMap<string, readonly DriveRow[]>>(new Map())
  const [renaming, setRenaming] = createSignal<string | undefined>()
  const [problem, setProblem] = createSignal<string | undefined>()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [target, setTarget] = createSignal<Target | undefined>()
  const menu = createOverlayMount(menuOpen)
  let chosen: string | undefined

  const fill = async (folder: string): Promise<void> => {
    const rows = await props.load(folder)
    setChildren((now) => new Map(now).set(folder, rows))
  }

  onMount(() => {
    const element = tree()
    if (element === null || element === undefined) return
    element.loadChildren = (folder) => fill(folder)
  })

  createEffect(
    on(
      () => props.rows,
      () => {
        const refills = [...untrack(children).keys()].map((folder) => fill(folder).catch(() => undefined))
        const path = landing
        landing = undefined
        if (path !== undefined) void Promise.all(refills).then(() => focus(path))
      },
      { defer: true },
    ),
  )

  const siblingsOf = (path: string): readonly string[] => {
    const folder = folderOf(path)
    const rows = folder === "" ? props.rows : (children().get(folder) ?? [])
    return rows.map((row) => row.name)
  }

  const itemOf = (node: EventTarget | null | undefined): Target | undefined => {
    const item = node instanceof Element ? node.closest("ui-tree-item") : null
    const path = item?.getAttribute("value")
    return path === null || path === undefined ? undefined : { path, folder: item?.hasAttribute("data-branch") === true }
  }

  const focus = (path: string): void => queueMicrotask(() => tree()?.api.focus(path))

  const startRename = (path: string): void => {
    setProblem(undefined)
    setRenaming(path)
  }

  let saving = false
  let landing: string | undefined
  const finishRename = (path: string, name: string, commit: boolean): void => {
    if (renaming() !== path || saving) return
    const current = path.slice(folderOf(path).length)
    const trimmed = name.trim()
    if (!commit || trimmed === current) {
      setRenaming(undefined)
      focus(path)
      return
    }
    const refused = renameProblem(trimmed, current, siblingsOf(path))
    if (refused !== undefined) {
      setProblem(refused)
      return
    }
    const to = `${folderOf(path)}${trimmed}`
    saving = true
    props
      .onRename(path, to)
      .then(
        () => {
          landing = to
          setRenaming(undefined)
          focus(to)
        },
        (failure: unknown) => setProblem(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => {
        saving = false
      })
  }

  const run = (command: string): void => {
    const picked = target()
    if (picked === undefined) return
    switch (command) {
      case "open":
        return props.onOpen(picked.path)
      case "rename":
        return startRename(picked.path)
      case "move":
        return props.onMove(picked.path)
      case "delete":
        return props.onDelete(picked.path)
      case "toggle":
        tree()?.api.toggle(picked.path)
        return focus(picked.path)
    }
  }

  const Rows = (rowsProps: { rows: readonly DriveRow[] }): JSX.Element => (
    <For each={rowsProps.rows}>
      {(row) => (
        <ui-tree-item value={valueOf(row)} label={row.name} branch={row.kind === "folder" ? "" : undefined} class="block outline-none">
          <ui-tree-item-label class={ROW}>
            <Show when={row.kind === "folder"} fallback={<span class="size-4 shrink-0" />}>
              <ui-tree-item-indicator class="im-chevron group/ind grid size-4 shrink-0 place-items-center text-icon data-[expanded]:[transform:rotate(90deg)]">
                <ChevronRight size={14} stroke-width={1.5} class="group-data-[failed]/ind:hidden group-data-[loading]/ind:hidden" />
                <LoaderCircle size={14} stroke-width={1.5} class="hidden animate-spin group-data-[loading]/ind:block" />
                <RotateCw size={12} stroke-width={1.5} class="hidden text-failed group-data-[failed]/ind:block" />
              </ui-tree-item-indicator>
            </Show>
            <RowIcon row={row} />
            <Show
              when={renaming() === valueOf(row)}
              fallback={
                <>
                  <span class="min-w-0 flex-1 truncate">{row.name}</span>
                  <Show when={row.kind === "file" && props.shares[row.entry.path] !== undefined}>
                    <Link2 size={12} stroke-width={1.5} class="shrink-0 text-primary-ink" aria-label="Shared" />
                  </Show>
                  <Show when={row.kind === "folder" && row.path === `${SKILLS_FOLDER}/`}>
                    <span class="shrink-0 text-mini text-ink-3">Installed skills</span>
                  </Show>
                </>
              }
            >
              <RenameField
                name={row.name}
                problem={problem()}
                onInput={() => setProblem(undefined)}
                onDone={(name, commit) => finishRename(valueOf(row), name, commit)}
              />
            </Show>
          </ui-tree-item-label>
          <Show when={row.kind === "folder" ? children().get(row.path) : undefined}>
            {(rows) => (
              <ui-tree-group class={GROUP}>
                <Rows rows={rows()} />
              </ui-tree-group>
            )}
          </Show>
        </ui-tree-item>
      )}
    </For>
  )

  return (
    <div ref={host} class="flex flex-col">
      <ui-menu
        on:openchange={(event) => {
          if (event.detail.value && (target() === undefined || renaming() !== undefined)) {
            event.preventDefault()
            return
          }
          setMenuOpen(event.detail.value)
          const was = target()
          if (!event.detail.value && was !== undefined && event.detail.reason === "escape-key") focus(was.path)
        }}
        on:openchangecomplete={(event) => {
          menu.settle(event)
          if (event.detail.value || chosen === undefined) return
          const command = chosen
          chosen = undefined
          run(command)
        }}
        on:action={(event) => {
          chosen = event.detail.value
        }}
      >
        <ui-menu-context-trigger class="block">
          <ui-tree
            aria-label={props.label}
            on:action={(event) => {
              if (renaming() !== undefined) return
              const picked = itemOf(host?.querySelector(`ui-tree-item[value="${CSS.escape(event.detail.value)}"]`))
              if (picked !== undefined && !picked.folder) props.onOpen(picked.path)
            }}
            on:contextmenu={(event) => setTarget(itemOf(event.target))}
            on:keydown={(event) => {
              if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) setTarget(itemOf(event.target))
              if (event.key !== "F2" || renaming() !== undefined) return
              const picked = itemOf(document.activeElement)
              if (picked === undefined || picked.folder) return
              event.preventDefault()
              startRename(picked.path)
            }}
            class="flex flex-col outline-none"
          >
            <Rows rows={props.rows} />
          </ui-tree>
        </ui-menu-context-trigger>
        <ui-menu-content final-focus="none" class={`${POPUP} w-[220px]`}>
          <Show when={menu.mounted() ? target() : undefined}>
            {(picked) => (
              <Show
                when={!picked().folder}
                fallback={
                  <ui-menu-item value="toggle" class={POPUP_ITEM}>
                    {tree()?.api.isExpanded(picked().path) === true ? "Collapse" : "Expand"}
                  </ui-menu-item>
                }
              >
                <ui-menu-item value="open" class={POPUP_ITEM}>
                  Open
                </ui-menu-item>
                <ui-menu-item value="rename" label="Rename" class={POPUP_ITEM}>
                  <span class="flex-1">Rename</span>
                  <kbd class="font-mono text-micro text-ink-3">F2</kbd>
                </ui-menu-item>
                <ui-menu-item value="move" class={POPUP_ITEM}>
                  Move…
                </ui-menu-item>
                <ui-menu-separator class={POPUP_SEPARATOR} />
                <ui-menu-item value="delete" class={`${POPUP_ITEM} text-failed`}>
                  Delete
                </ui-menu-item>
              </Show>
            )}
          </Show>
        </ui-menu-content>
      </ui-menu>
    </div>
  )
}

function RenameField(props: {
  name: string
  problem: string | undefined
  onInput: () => void
  onDone: (name: string, commit: boolean) => void
}): JSX.Element {
  let field: HTMLInputElement | undefined
  onMount(() =>
    queueMicrotask(() => {
      if (field === undefined) return
      field.focus()
      const dot = props.name.lastIndexOf(".")
      field.setSelectionRange(0, dot > 0 ? dot : props.name.length)
    }),
  )
  return (
    <span class="relative flex min-w-0 flex-1">
      <ui-input class="flex min-w-0 flex-1">
        <input
          ref={field}
          value={props.name}
          aria-label={`Rename ${props.name}`}
          aria-invalid={props.problem !== undefined}
          spellcheck={false}
          class="h-[calc(var(--h-row)-6px)] min-w-0 flex-1 rounded-xs border border-primary/40 bg-panel px-1 text-small text-ink outline-none aria-[invalid=true]:border-failed"
          on:pointerdown={(event) => event.stopPropagation()}
          on:click={(event) => event.stopPropagation()}
          onInput={() => props.onInput()}
          on:keydown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              props.onDone(field?.value ?? props.name, true)
            }
            if (event.key === "Escape") {
              event.preventDefault()
              props.onDone(field?.value ?? props.name, false)
            }
          }}
          onBlur={(event) => props.onDone(event.currentTarget.value, props.problem === undefined)}
        />
      </ui-input>
      <Show when={props.problem}>
        {(message) => (
          <span role="alert" class="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded-xs bg-popover px-1.5 py-0.5 text-micro text-failed shadow-[var(--shadow-popover)]">
            {message()}
          </span>
        )}
      </Show>
    </span>
  )
}
