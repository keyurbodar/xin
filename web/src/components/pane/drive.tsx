import { batch, createMemo, createResource, createSignal, For, Show, untrack, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Menu } from "@ark-ui/solid/menu"
import {
  ArrowLeft,
  BookText,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  File,
  Folder,
  FolderInput,
  History,
  Link2,
  Pencil,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-solid"
import { putFile } from "../../lib/api.ts"
import {
  copyLink,
  crumbsOf,
  drive,
  folderOf,
  INSTRUCTIONS_CAP,
  INSTRUCTIONS_FILE,
  isStale,
  moveTarget,
  pickScope,
  reservedOf,
  resolveConflict,
  rowsOf,
  saveBlock,
  scopeTitle,
  shareUrl,
  SKILLS_FOLDER,
  splitUploads,
  uploadPath,
  uploadSummary,
  writeArgs,
  type ConflictChoice,
  type CopyOutcome,
  type DriveEntry,
  type DriveFile,
  type DriveListing,
  type DriveScope,
  type DriveWrite,
  type MountedScope,
  type Reserved,
} from "../../lib/drive.ts"
import { ago, bytes } from "../../lib/format.ts"
import { firstLoad, settled } from "../../lib/loading.ts"
import { Button } from "../ui/button.tsx"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"
import { Spinner } from "../ui/loaders.tsx"
import { Loading, PaneSkeleton } from "../ui/skeleton.tsx"
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM, MENU_LABEL } from "../shell/menu.ts"
import { Markdown } from "../chat/markdown.tsx"
import { createPaneAction, EmptyState, ResourceError } from "../chat/ui.tsx"
import { fileName as baseName, forgetProjectFiles, PANE_ROW } from "./bodies.tsx"

const ICON = { size: 16, "stroke-width": 1.5 } as const
const CENTER_ROW = PANE_ROW.replace("items-start", "items-center")

const SMALL = { size: 14, "stroke-width": 1.5 } as const

function ReservedIcon(props: { reserved: Reserved | undefined; class: string }): JSX.Element {
  return (
    <Show when={props.reserved} fallback={<File {...ICON} class={props.class} />}>
      {(reserved) => (reserved().kind === "instructions" ? <BookText {...ICON} class={props.class} /> : <Sparkles {...ICON} class={props.class} />)}
    </Show>
  )
}

function ReservedNote(props: { reserved: Reserved }): JSX.Element {
  return (
    <div class="mx-2 mb-2 flex items-start gap-2 rounded-sm border border-line-2 bg-secondary px-2.5 py-2 text-xs leading-[1.5] text-ink-2">
      <ReservedIcon reserved={props.reserved} class="mt-px shrink-0 text-ink-3" />
      <span>
        {props.reserved.kind === "instructions"
          ? `Every conversation in this scope reads this file as instructions, up to ${INSTRUCTIONS_CAP.toLocaleString()} characters.`
          : `Installs the skill ${props.reserved.name} for every conversation in this scope. Its frontmatter name must match the folder.`}
      </span>
    </div>
  )
}

const clipboard = (): ((text: string) => Promise<void>) | undefined =>
  navigator.clipboard === undefined ? undefined : (text) => navigator.clipboard.writeText(text)

/** The right pane's Drive: the conversation's scopes, one folder at a time, and the open file. One drive.list per folder open and per op. */
export function DriveView(props: { conversationId: number; prefer: DriveScope; projectSlug: string }): JSX.Element {
  const [scopes, { refetch: refetchScopes }] = createResource(() => props.conversationId, drive.scopes)
  const [picked, setPicked] = createSignal<string | undefined>()
  const [folder, setFolder] = createSignal("")
  const [open, setOpen] = createSignal<string | undefined>()
  const [version, setVersion] = createSignal(0)
  const [dropping, setDropping] = createSignal(false)
  const action = createPaneAction()

  const current = createMemo(() => pickScope(settled(scopes) ?? [], picked(), props.prefer))
  const listKey = createMemo(() => {
    const mounted = current()
    return mounted === undefined ? undefined : `${mounted.root}\n${folder()}\n${version()}`
  })
  const [listing, { refetch: refetchListing }] = createResource(listKey, (): Promise<DriveListing> => {
    const mounted = untrack(current)
    if (mounted === undefined) throw new Error("no scope")
    return drive.list(mounted.scope, untrack(folder))
  })
  const rows = createMemo(() => rowsOf(settled(listing)?.files ?? [], folder()))
  const openEntry = (): DriveEntry | undefined => settled(listing)?.files.find((entry) => entry.path === open())

  const reload = (): void => {
    forgetProjectFiles(props.projectSlug)
    setVersion((value) => value + 1)
  }
  const choose = (root: string): void =>
    batch(() => {
      setPicked(root)
      setFolder("")
      setOpen(undefined)
    })

  const upload = (picked: FileList): void => {
    const mounted = current()
    if (mounted === undefined) return
    const { send, tooBig } = splitUploads(Array.from(picked))
    void action.run("upload", async () => {
      const results = await Promise.allSettled(send.map((file) => putFile(file, uploadPath(mounted.root, folder(), file.name))))
      if (send.length > 0) reload()
      const failed = send.filter((_, index) => results[index]?.status === "rejected").map((file) => file.name)
      const summary = uploadSummary(
        tooBig.map((file) => file.name),
        failed,
      )
      if (summary !== undefined) throw new Error(summary)
    })
  }

  return (
    <div
      class="flex min-h-full flex-col"
      onDragOver={(event) => {
        if (open() !== undefined || !event.dataTransfer?.types.includes("Files")) return
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDropping(false)
        const dropped = event.dataTransfer?.files
        if (dropped !== undefined && dropped.length > 0) upload(dropped)
      }}
    >
      <Show when={scopes.error}>
        <ResourceError what="Drive scopes" error={scopes.error} onRetry={() => void refetchScopes()} />
      </Show>
      <Show when={current()}>
        {(mounted) => (
          <>
            <div class="flex items-center gap-1 px-1 pb-1">
              <ScopeMenu scopes={settled(scopes) ?? []} current={mounted()} onChoose={choose} />
              <span class="flex-1" />
              <Show when={action.busy() === "upload"}>
                <Spinner size={14} class="text-ink-3" />
              </Show>
              <label class={`${ICON_BUTTON} cursor-pointer`} aria-label="Upload files" title="Upload files">
                <Upload {...SMALL} />
                <input
                  type="file"
                  multiple
                  class="hidden"
                  onChange={(event) => {
                    const files = event.currentTarget.files
                    if (files !== null && files.length > 0) upload(files)
                    event.currentTarget.value = ""
                  }}
                />
              </label>
            </div>

            <Show when={folder() !== ""}>
              <nav class="flex min-w-0 items-center gap-0.5 px-1 pb-1.5 text-xs text-ink-3" aria-label="Folder">
                <button
                  type="button"
                  class="shrink-0 rounded-xs px-1 py-0.5 hover:bg-secondary hover:text-ink"
                  onClick={() => {
                    setFolder("")
                    setOpen(undefined)
                  }}
                >
                  {scopeTitle(mounted().scope)}
                </button>
                <For each={crumbsOf(folder())}>
                  {(crumb) => (
                    <>
                      <ChevronRight size={12} stroke-width={1.5} class="shrink-0 text-icon" />
                      <button
                        type="button"
                        class="min-w-0 truncate rounded-xs px-1 py-0.5 hover:bg-secondary hover:text-ink"
                        classList={{ "text-ink": crumb.path === folder() && open() === undefined }}
                        onClick={() => {
                          setFolder(crumb.path)
                          setOpen(undefined)
                        }}
                      >
                        {crumb.name}
                      </button>
                    </>
                  )}
                </For>
              </nav>
            </Show>

            <Show when={action.failed()}>
              {(message) => <p class="mx-2 mb-2 font-mono text-2xs text-failed">{message()}</p>}
            </Show>

            <Show
              when={open()}
              keyed
              fallback={
                <Loading when={firstLoad(listing)} skeleton={<PaneSkeleton rows={6} />} label="Loading Drive">
                  <Show when={listing.error}>
                    <ResourceError what="this folder" error={listing.error} onRetry={() => void refetchListing()} />
                  </Show>
                  <div
                    class="flex flex-1 flex-col rounded-md transition-colors duration-[var(--dur-color)]"
                    classList={{ "bg-primary-soft": dropping() }}
                  >
                    <Show when={settled(listing) !== undefined && rows().length === 0}>
                      <EmptyState
                        pictogram="folder"
                        title={folder() === "" ? "Nothing in this drive yet" : "This folder is empty"}
                        detail={`Drop files here or upload them. ${INSTRUCTIONS_FILE} at the root becomes instructions, and ${SKILLS_FOLDER}/<name>/SKILL.md installs a skill.`}
                      />
                    </Show>
                    <For each={rows()}>
                      {(row) =>
                        row.kind === "folder" ? (
                          <button type="button" class={CENTER_ROW} onClick={() => setFolder(row.path)}>
                            <Show when={row.path === `${SKILLS_FOLDER}/`} fallback={<Folder {...ICON} class="shrink-0 text-ink-3" />}>
                              <Sparkles {...ICON} class="shrink-0 text-ink-3" />
                            </Show>
                            <span class="min-w-0 flex-1 truncate text-sm text-ink">{row.name}</span>
                            <Show when={row.path === `${SKILLS_FOLDER}/`}>
                              <span class="shrink-0 text-xs text-ink-3">Installed skills</span>
                            </Show>
                            <span class="shrink-0 font-mono text-2xs text-ink-3">{row.files}</span>
                          </button>
                        ) : (
                          <button type="button" class={PANE_ROW} onClick={() => setOpen(row.entry.path)}>
                            <ReservedIcon reserved={reservedOf(row.entry.path)} class="mt-0.5 shrink-0 text-ink-3" />
                            <span class="min-w-0 flex-1">
                              <span class="flex items-center gap-1.5">
                                <span class="truncate text-sm text-ink">{row.name}</span>
                                <Show when={settled(listing)?.shares[row.entry.path] !== undefined}>
                                  <span class="flex shrink-0 items-center gap-1 rounded-xs border border-primary/30 bg-primary-soft px-1 text-2xs text-primary-ink">
                                    <Link2 size={10} stroke-width={1.75} />
                                    Shared
                                  </span>
                                </Show>
                              </span>
                              <span class="block truncate text-xs text-ink-3">
                                {reservedOf(row.entry.path)?.kind === "instructions"
                                  ? "Instructions · "
                                  : reservedOf(row.entry.path)?.kind === "skill"
                                    ? "Skill · "
                                    : ""}
                                {ago(row.entry.updated_at)}
                              </span>
                            </span>
                            <span class="shrink-0 font-mono text-2xs text-ink-3">{bytes(row.entry.size)}</span>
                          </button>
                        )
                      }
                    </For>
                  </div>
                </Loading>
              }
            >
              {(path) => (
                <FilePanel
                  mounted={mounted()}
                  scopes={settled(scopes) ?? []}
                  path={path}
                  entry={openEntry()}
                  shareId={settled(listing)?.shares[path]}
                  onBack={() => setOpen(undefined)}
                  onChanged={reload}
                  onMoved={(to, root) => {
                    if (root !== mounted().root) {
                      forgetProjectFiles(props.projectSlug)
                      return choose(root)
                    }
                    batch(() => {
                      setFolder(folderOf(to))
                      setOpen(to)
                      reload()
                    })
                  }}
                  onDeleted={() => {
                    setOpen(undefined)
                    reload()
                  }}
                />
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={firstLoad(scopes)}>
        <PaneSkeleton rows={6} />
      </Show>
    </div>
  )
}

function ScopeMenu(props: { scopes: readonly MountedScope[]; current: MountedScope; onChoose: (root: string) => void }): JSX.Element {
  return (
    <Menu.Root
      lazyMount
      unmountOnExit
      positioning={{ placement: "bottom-start", gutter: 6 }}
      onSelect={(details) => props.onChoose(details.value)}
    >
      <Menu.Trigger class="flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-2 text-sm text-ink transition-colors duration-[var(--dur-color)] hover:bg-secondary data-[state=open]:bg-hover">
        <span class="shrink-0">{scopeTitle(props.current.scope)}</span>
        <span class="min-w-0 truncate text-ink-3">{props.current.root}</span>
        <ChevronsUpDown size={12} stroke-width={1.5} class="shrink-0 text-icon" />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class={`${MENU_CONTENT} w-[260px]`}>
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel class={MENU_LABEL}>This conversation sees</Menu.ItemGroupLabel>
              <For each={props.scopes}>
                {(mounted) => (
                  <Menu.Item value={mounted.root} class={MENU_ITEM}>
                    <span class="min-w-0 flex-1 truncate">{scopeTitle(mounted.scope)}</span>
                    <span class="truncate font-mono text-2xs text-ink-3">{mounted.root}</span>
                    <span class="w-3.5 shrink-0 text-ink-2">
                      <Show when={mounted.root === props.current.root}>
                        <Check {...SMALL} />
                      </Show>
                    </span>
                  </Menu.Item>
                )}
              </For>
            </Menu.ItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}

type Mode = "read" | "edit" | "history"

function FilePanel(props: {
  mounted: MountedScope
  scopes: readonly MountedScope[]
  path: string
  entry: DriveEntry | undefined
  shareId: string | undefined
  onBack: () => void
  onChanged: () => void
  onMoved: (to: string, root: string) => void
  onDeleted: () => void
}): JSX.Element {
  const scope = (): DriveScope => props.mounted.scope
  const reserved = (): Reserved | undefined => reservedOf(props.path)
  const [mode, setMode] = createSignal<Mode>("read")
  const [file, { mutate, refetch }] = createResource(() => props.path, (path) => drive.read(scope(), path))
  const [draft, setDraft] = createSignal("")
  const [conflict, setConflict] = createSignal(false)
  const [moving, setMoving] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const action = createPaneAction()

  const edit = (): void => {
    setDraft(settled(file)?.text ?? "")
    setConflict(false)
    setMode("edit")
  }
  const blocked = (): string | undefined => saveBlock(props.path, draft())
  const write = async (args: DriveWrite): Promise<void> => {
    try {
      const entry = await drive.write(args)
      mutate({ ...entry, text: args.text })
      setConflict(false)
      setMode("read")
      props.onChanged()
    } catch (problem) {
      if (!isStale(problem)) throw problem
      setConflict(true)
    }
  }
  const save = (): void => {
    if (blocked() !== undefined) return
    void action.run("save", () => write(writeArgs(scope(), props.path, draft(), settled(file))))
  }
  const settle = (choice: ConflictChoice): void =>
    void action.run("save", async () => {
      const current = await drive.read(scope(), props.path)
      const next = resolveConflict(choice, writeArgs(scope(), props.path, draft(), settled(file)), current)
      if (next.kind === "reload") {
        mutate(current)
        setConflict(false)
        setMode("read")
        return
      }
      await write(next.write)
    })
  const [copied, setCopied] = createSignal<CopyOutcome | undefined>()
  let focusNext: "link" | "share" | undefined
  let linkField: HTMLInputElement | undefined
  const focusOnce = (target: "link" | "share", element: HTMLElement): void => {
    if (focusNext !== target) return
    focusNext = undefined
    queueMicrotask(() => {
      element.focus()
      if (element instanceof HTMLInputElement) element.select()
    })
  }
  const copy = async (url: string): Promise<void> => {
    const outcome = await copyLink(url, clipboard())
    setCopied(outcome)
    if (outcome === "manual") {
      linkField?.focus()
      linkField?.select()
      return
    }
    setTimeout(() => setCopied((now) => (now === "copied" ? undefined : now)), 1500)
  }
  const share = (): void =>
    void action.run("share", async () => {
      const link = await drive.share(scope(), props.path)
      focusNext = "link"
      props.onChanged()
      await copy(`${location.origin}${link.url}`)
    })
  const unshare = (): void =>
    void action.run("share", async () => {
      await drive.unshare(scope(), props.path)
      setCopied(undefined)
      focusNext = "share"
      props.onChanged()
    })

  const text = (): string | null => settled(file)?.text ?? null
  const isText = (): boolean => text() !== null

  return (
    <div class="flex flex-1 flex-col">
      <div class="flex items-center gap-1 px-1 pb-2">
        <button type="button" class={ICON_BUTTON} aria-label="Back to the folder" onClick={() => props.onBack()}>
          <ArrowLeft {...SMALL} />
        </button>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium text-ink">{baseName(props.path)}</span>
          <Show when={props.entry ?? settled(file)}>
            {(entry) => (
              <span class="block truncate font-mono text-2xs text-ink-3">
                {bytes(entry().size)} · {ago(entry().updated_at)}
              </span>
            )}
          </Show>
        </span>
        <Show when={isText() && mode() !== "edit"}>
          <button type="button" class={ICON_BUTTON} aria-label="Edit" title="Edit" onClick={edit}>
            <Pencil {...SMALL} />
          </button>
        </Show>
        <button
          type="button"
          class={ICON_BUTTON}
          classList={{ "bg-hover text-ink": mode() === "history" }}
          aria-label="History"
          title="History"
          aria-pressed={mode() === "history"}
          onClick={() => setMode(mode() === "history" ? "read" : "history")}
        >
          <History {...SMALL} />
        </button>
        <Show when={props.shareId === undefined}>
          <button
            type="button"
            class={ICON_BUTTON}
            aria-label="Share a link"
            title="Share a link"
            ref={(element) => focusOnce("share", element)}
            disabled={action.busy() === "share"}
            onClick={share}
          >
            <Link2 {...SMALL} />
          </button>
        </Show>
        <button type="button" class={ICON_BUTTON} aria-label="Move or rename" title="Move or rename" onClick={() => setMoving(true)}>
          <FolderInput {...SMALL} />
        </button>
        <button type="button" class={`${ICON_BUTTON} hover:text-failed`} aria-label="Delete" title="Delete" onClick={() => setDeleting(true)}>
          <Trash2 {...SMALL} />
        </button>
      </div>

      <Show when={reserved()}>{(kind) => <ReservedNote reserved={kind()} />}</Show>

      <Show when={props.shareId}>
        {(id) => (
          <div class="mx-2 mb-2 flex items-center gap-2 rounded-sm border border-primary/30 bg-primary-soft py-1 pl-2.5 pr-1 text-xs">
            <Link2 size={12} stroke-width={1.5} class="shrink-0 text-primary-ink" />
            <input
              ref={(element) => {
                linkField = element
                focusOnce("link", element)
              }}
              readonly
              aria-label="Share link"
              title="Anyone with this link can open the file"
              value={shareUrl(location.origin, id(), props.path)}
              onFocus={(event) => event.currentTarget.select()}
              class="min-w-0 flex-1 truncate bg-transparent font-mono text-2xs text-ink-2 outline-none"
            />
            <button
              type="button"
              class={ICON_BUTTON}
              aria-label={copied() === "copied" ? "Copied" : "Copy link"}
              title={copied() === "copied" ? "Copied" : "Copy link"}
              onClick={() => void copy(shareUrl(location.origin, id(), props.path))}
            >
              <Show when={copied() === "copied"} fallback={<Copy {...SMALL} />}>
                <Check {...SMALL} class="text-done" />
              </Show>
            </button>
            <button type="button" class="link shrink-0 pr-1.5 text-xs" disabled={action.busy() === "share"} onClick={unshare}>
              Stop sharing
            </button>
          </div>
        )}
      </Show>
      <Show when={props.shareId !== undefined && copied() === "manual"}>
        <p role="status" class="mx-2 mb-2 font-mono text-2xs text-failed">
          The browser blocked the clipboard. The link is selected: press Ctrl+C (⌘C on a Mac) to copy it.
        </p>
      </Show>

      <Show when={action.failed()}>
        {(message) => <p class="mx-2 mb-2 font-mono text-2xs text-failed">{message()}</p>}
      </Show>

      <Show when={file.error}>
        <ResourceError what={baseName(props.path)} error={file.error} onRetry={() => void refetch()} />
      </Show>

      <Show when={mode() === "history"}>
        <HistoryPanel
          scope={scope()}
          path={props.path}
          onRestored={() => {
            void refetch()
            setMode("read")
            props.onChanged()
          }}
        />
      </Show>

      <Show when={mode() === "edit"}>
        <div class="flex flex-1 flex-col gap-2 px-2">
          <textarea
            autofocus
            spellcheck={false}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                save()
              }
              if (event.key === "Escape") setMode("read")
            }}
            class={`${FIELD_INPUT} min-h-[320px] flex-1 resize-none py-2 font-mono text-sm leading-[1.6]`}
          />
          <Show when={conflict()}>
            <div class="flex items-center gap-2 rounded-sm border border-needs/40 bg-secondary px-2.5 py-2 text-xs text-ink-2" role="alert">
              <span class="min-w-0 flex-1">This file changed since you opened it, in another tab or by an agent.</span>
              <Button size="sm" variant="quiet" disabled={action.busy() === "save"} onClick={() => settle("reload")}>
                Reload
              </Button>
              <Button size="sm" variant="ghost" disabled={action.busy() === "save"} onClick={() => settle("overwrite")}>
                Overwrite
              </Button>
            </div>
          </Show>
          <Show when={blocked()}>{(message) => <p class="text-xs text-failed">{message()}</p>}</Show>
          <div class="flex items-center gap-2">
            <Show when={reserved()?.kind === "instructions"}>
              <span
                class="font-mono text-2xs"
                classList={{ "text-failed": draft().length > INSTRUCTIONS_CAP, "text-ink-3": draft().length <= INSTRUCTIONS_CAP }}
              >
                {draft().length.toLocaleString()} / {INSTRUCTIONS_CAP.toLocaleString()}
              </span>
            </Show>
            <span class="flex-1" />
            <Button size="sm" variant="quiet" onClick={() => setMode("read")}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={action.busy() === "save" || draft() === text() || conflict() || blocked() !== undefined}
              onClick={save}
            >
              {action.busy() === "save" ? "Saving" : "Save"}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={mode() === "read"}>
        <Loading when={firstLoad(file)} skeleton={<PaneSkeleton rows={3} />} label="Opening file">
          <Show when={settled(file)}>
            {(loaded) => <FileBody file={loaded()} />}
          </Show>
        </Loading>
      </Show>

      <MoveDialog
        open={moving()}
        scopes={props.scopes}
        mounted={props.mounted}
        path={props.path}
        onClose={() => setMoving(false)}
        onMoved={(to, root) => {
          setMoving(false)
          props.onMoved(to, root)
        }}
      />
      <DeleteDialog
        open={deleting()}
        scope={scope()}
        path={props.path}
        shared={props.shareId !== undefined}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false)
          props.onDeleted()
        }}
      />
    </div>
  )
}

function FileBody(props: { file: DriveFile }): JSX.Element {
  return (
    <Show
      when={props.file.text}
      fallback={<EmptyState pictogram="files" title="No text preview" detail={`${props.file.type} · ${bytes(props.file.size)}`} />}
    >
      {(text) => (
        <div class="px-2 pb-4">
          <Show
            when={props.file.type === "text/markdown"}
            fallback={<pre class="whitespace-pre-wrap break-words font-mono text-xs leading-[1.6] text-ink-2">{text()}</pre>}
          >
            <Markdown text={text()} small />
          </Show>
        </div>
      )}
    </Show>
  )
}

function HistoryPanel(props: { scope: DriveScope; path: string; onRestored: () => void }): JSX.Element {
  const [history, { refetch }] = createResource(() => props.path, (path) => drive.history(props.scope, path))
  const [viewing, setViewing] = createSignal<string | undefined>()
  const [older] = createResource(viewing, (sha256) => drive.read(props.scope, props.path, sha256))
  const action = createPaneAction()

  const restore = (sha256: string): void =>
    void action.run(sha256, async () => {
      await drive.checkout(props.scope, props.path, sha256)
      props.onRestored()
    })

  return (
    <div class="flex flex-col px-1 pb-3">
      <Show when={history.error}>
        <ResourceError what="history" error={history.error} onRetry={() => void refetch()} />
      </Show>
      <Loading when={firstLoad(history)} skeleton={<PaneSkeleton rows={3} />} label="Loading history">
        <Show when={settled(history)}>
          {(data) => (
            <>
              <div class="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-done" />
                <span class="flex-1 text-ink">Current</span>
                <span class="font-mono text-2xs text-ink-3">{data().current.sha256.slice(0, 8)}</span>
                <span class="w-12 text-right font-mono text-2xs text-ink-3">{ago(data().current.at)}</span>
              </div>
              <For
                each={data().versions}
                fallback={<p class="px-2 py-1.5 text-xs text-ink-3">No earlier versions. Drive keeps the last five.</p>}
              >
                {(entry) => (
                  <button
                    type="button"
                    class={CENTER_ROW}
                    classList={{ "bg-hover": viewing() === entry.sha256 }}
                    aria-pressed={viewing() === entry.sha256}
                    onClick={() => setViewing(viewing() === entry.sha256 ? undefined : entry.sha256)}
                  >
                    <span class="h-1.5 w-1.5 shrink-0 rounded-full border border-line-3" />
                    <span class="flex-1 text-sm text-ink-2">{bytes(entry.size)}</span>
                    <span class="font-mono text-2xs text-ink-3">{entry.sha256.slice(0, 8)}</span>
                    <span class="w-12 text-right font-mono text-2xs text-ink-3">{ago(entry.at)}</span>
                  </button>
                )}
              </For>
            </>
          )}
        </Show>
      </Loading>
      <Show when={viewing()}>
        {(sha256) => (
          <div class="mt-2 flex flex-col gap-2 rounded-md border border-line-2 p-2">
            <div class="flex items-center gap-2">
              <span class="flex-1 text-xs text-ink-3">Earlier version · {ago(settled(older)?.updated_at)}</span>
              <Button size="sm" variant="ghost" disabled={action.busy() !== undefined} onClick={() => restore(sha256())}>
                {action.busy() === sha256() ? "Restoring" : "Restore this version"}
              </Button>
            </div>
            <Show when={action.failed()}>
              {(message) => <p class="font-mono text-2xs text-failed">{message()}</p>}
            </Show>
            <Loading when={firstLoad(older)} skeleton={<PaneSkeleton rows={2} />} label="Opening version">
              <Show when={settled(older)}>{(loaded) => <FileBody file={loaded()} />}</Show>
            </Loading>
          </div>
        )}
      </Show>
    </div>
  )
}

function MoveDialog(props: {
  open: boolean
  scopes: readonly MountedScope[]
  mounted: MountedScope
  path: string
  onClose: () => void
  onMoved: (to: string, root: string) => void
}): JSX.Element {
  const [to, setTo] = createSignal("")
  const [root, setRoot] = createSignal("")
  const action = createPaneAction()
  resetOnOpen(
    () => props.open,
    () => {
      setTo(props.path)
      setRoot(props.mounted.root)
    },
  )
  const target = (): MountedScope | undefined => props.scopes.find((mounted) => mounted.root === root())
  const destination = (): string | undefined => moveTarget(to(), props.path, root() === props.mounted.root)
  const submit = (): void => {
    const scope = target()
    const path = destination()
    if (scope === undefined || path === undefined) return
    void action.run("move", async () => {
      const entry = await drive.move(props.mounted.scope, props.path, path, scope.scope)
      props.onMoved(entry.path, scope.root)
    })
  }
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Move or rename"
      width="w-[440px]"
      busy={action.busy() !== undefined}
      onSubmit={submit}
      footer={
        <>
          <Show when={action.failed()}>
            {(message) => <span class="min-w-0 flex-1 truncate font-mono text-2xs text-failed">{message()}</span>}
          </Show>
          <span class="flex-1" />
          <Button size="sm" variant="quiet" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={destination() === undefined || action.busy() !== undefined}>
            Move
          </Button>
        </>
      }
    >
      <Show when={props.scopes.length > 1}>
        <Field label="Scope">
          <select class={`${FIELD_INPUT} h-[34px]`} value={root()} onChange={(event) => setRoot(event.currentTarget.value)}>
            <For each={props.scopes}>
              {(mounted) => (
                <option value={mounted.root}>
                  {scopeTitle(mounted.scope)} · {mounted.root}
                </option>
              )}
            </For>
          </select>
        </Field>
      </Show>
      <Field label="Path" hint={`Inside ${target()?.root ?? props.mounted.root}. Earlier versions and the share link move with the file.`}>
        <input class={`${FIELD_INPUT} h-[34px] font-mono text-sm`} value={to()} onInput={(event) => setTo(event.currentTarget.value)} autofocus />
      </Field>
    </Dialog>
  )
}

function DeleteDialog(props: {
  open: boolean
  scope: DriveScope
  path: string
  shared: boolean
  onClose: () => void
  onDeleted: () => void
}): JSX.Element {
  const action = createPaneAction()
  const submit = (): void =>
    void action.run("delete", async () => {
      await drive.remove(props.scope, props.path)
      props.onDeleted()
    })
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={`Delete ${baseName(props.path)}?`}
      width="w-[420px]"
      busy={action.busy() !== undefined}
      onSubmit={submit}
      footer={
        <>
          <Show when={action.failed()}>
            {(message) => <span class="min-w-0 flex-1 truncate font-mono text-2xs text-failed">{message()}</span>}
          </Show>
          <span class="flex-1" />
          <Button size="sm" variant="quiet" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" type="submit" disabled={action.busy() !== undefined}>
            {action.busy() === "delete" ? "Deleting" : "Delete"}
          </Button>
        </>
      }
    >
      <p class="text-sm leading-[1.5] text-ink-2">
        {`${props.path} and its earlier versions are removed for good.`}
        {props.shared ? " Its share link stops working." : ""}
        {reservedOf(props.path)?.kind === "instructions" ? " Conversations in this scope lose these instructions." : ""}
        {reservedOf(props.path)?.kind === "skill" ? " The skill is uninstalled from this scope." : ""}
      </p>
    </Dialog>
  )
}
