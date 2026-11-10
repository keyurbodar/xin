import { For, Show, createResource, createSignal, type JSX } from "solid-js"
import { cmd, uploadFile } from "../lib/api.ts"
import { setPendingDraft } from "../lib/draft.ts"
import { ago, bytes } from "../lib/format.ts"
import { navigate } from "../lib/router.ts"
import { mediaQuery } from "../lib/media.ts"
import type { ProjectSummary } from "../state/home.ts"
import { Markdown } from "../components/chat/markdown.tsx"
import { Skullet } from "../components/ui/skeleton.tsx"
import { Icon } from "../components/ui/icon.tsx"
import { EmptyState } from "../components/chat/ui.tsx"

export type FileEntry = {
  readonly path: string
  readonly size: number
  readonly type: string
  readonly sha256: string
  readonly updated_at: number
}

export type FileContent = FileEntry & { readonly text: string | null; readonly versions: number }

type Revision = { readonly sha256: string; readonly size: number; readonly type: string; readonly at: number }

const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const folder = (path: string, root: string): string => {
  const relative = path.startsWith(root) ? path.slice(root.length) : path
  const cut = relative.lastIndexOf("/")
  return cut === -1 ? "Project root" : relative.slice(0, cut)
}

function save(entry: { path: string; type: string }, text: string): void {
  const link = document.createElement("a")
  link.href = URL.createObjectURL(new Blob([text], { type: entry.type }))
  link.download = name(entry.path)
  link.click()
  URL.revokeObjectURL(link.href)
}

export function FileScreen(props: { project: ProjectSummary; path: string }): JSX.Element {
  const root = (): string => `/projects/${props.project.slug}/`
  const [version, setVersion] = createSignal(0)
  const [files, { refetch: refetchFiles }] = createResource(
    () => `${props.project.slug}:${version()}`,
    () => cmd<readonly FileEntry[]>("file.list", { prefix: `/projects/${props.project.slug}` }),
  )
  const [content] = createResource(
    () => props.path,
    (path) => cmd<FileContent>("file.read", { path }),
  )
  const [revisions] = createResource(
    () => props.path,
    (path) => cmd<{ revisions: readonly Revision[] }>("file.revisions", { path }),
  )
  const [viewing, setViewing] = createSignal<string | undefined>()
  const [older] = createResource(viewing, (sha256) => cmd<Revision & { text: string | null }>("file.revision", { path: props.path, sha256 }))
  const [copied, setCopied] = createSignal(false)
  const [dropping, setDropping] = createSignal(false)
  const wide = mediaQuery("(min-width: 1024px)")

  const shown = (): { text: string | null; type: string; size: number } | undefined => {
    const past = older()
    if (past !== undefined) return { text: past.text, type: past.type, size: past.size }
    const current = content()
    return current === undefined ? undefined : { text: current.text, type: current.type, size: current.size }
  }

  const copy = async (): Promise<void> => {
    const text = shown()?.text
    if (text === undefined || text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  const ask = (): void => {
    setPendingDraft(`About ${name(props.path)}: `)
    navigate(`/p/${props.project.slug}`)
  }

  const upload = async (dropped: FileList): Promise<void> => {
    const list = Array.from(dropped)
    await Promise.all(list.map((file) => uploadFile(file, root().replace(/\/$/u, ""))))
    setVersion((value) => value + 1)
    await refetchFiles()
  }

  return (
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <section class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <button type="button" class="link truncate text-[13px]" onClick={() => navigate(`/p/${props.project.slug}`)}>
            {props.project.name}
          </button>
          <span class="text-fg-4">/</span>
          <span class="text-[13px] text-fg-3">Files</span>
          <span class="text-fg-4">/</span>
          <span class="min-w-0 truncate text-[13px] font-medium text-fg">{name(props.path)}</span>
          <Show when={shown()}>
            {(entry) => (
              <span class="ml-auto shrink-0 font-mono text-[11.5px] text-fg-4">{bytes(entry().size)}</span>
            )}
          </Show>
          <Show when={content()}>
            {(entry) => (
              <Show when={entry().versions > 1 && viewing() === undefined}>
                <span class="shrink-0 rounded-[2px] border border-line-inner px-1.5 py-0.5 font-mono text-[10.5px] text-fg-3">
                  {entry().versions} versions
                </span>
              </Show>
            )}
          </Show>
          <Show when={shown()?.text ?? null}>
            <button
              type="button"
              class="shrink-0 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 hover:border-line-strong hover:text-fg"
              onClick={ask}
            >
              Ask about this
            </button>
            <button
              type="button"
              class="shrink-0 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 hover:border-line-strong hover:text-fg"
              onClick={() => void copy()}
            >
              {copied() ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              class="shrink-0 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 hover:border-line-strong hover:text-fg"
              onClick={() => {
                const text = shown()?.text
                if (text !== undefined && text !== null) save({ path: props.path, type: shown()?.type ?? "text/plain" }, text)
              }}
            >
              Download
            </button>
          </Show>
        </header>

        <Show when={viewing()}>
          {(sha) => (
            <div class="flex items-center gap-2 border-b border-accent-line bg-accent-dim px-4 py-2 text-[12px] text-fg-2">
              <span>Viewing an earlier version · {ago(older()?.at ?? Date.now())}</span>
              <span class="font-mono text-[10.5px] text-fg-4">{sha().slice(0, 12)}</span>
              <button type="button" class="ml-auto link text-[12px]" onClick={() => setViewing(undefined)}>
                Back to current
              </button>
            </div>
          )}
        </Show>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <Skullet loading={content.loading} sample={() => <div class="h-3 w-2/3 rounded-[1px] bg-hover" />} label="Opening file">
            <Show when={content()} fallback={<EmptyState pictogram="folder" title="File not found" detail="It may have been deleted." />}>
              {(entry) => (
                <Show
                  when={shown()?.text ?? null}
                  fallback={
                    <EmptyState
                      pictogram="files"
                      title={name(entry().path)}
                      detail={`${entry().type} · ${bytes(entry().size)}. No text preview for this type.`}
                    />
                  }
                >
                  {(text) => (
                    <article class="mx-auto max-w-[720px]">
                      <h1 class="mb-1 text-[20px] font-medium text-fg">{name(entry().path)}</h1>
                      <p class="mb-5 font-mono text-[11.5px] text-fg-4">{folder(entry().path, root())}</p>
                      <Show
                        when={(shown()?.type ?? "") === "text/markdown"}
                        fallback={<pre class="whitespace-pre-wrap font-mono text-[12.5px] leading-[1.6] text-fg-2">{text()}</pre>}
                      >
                        <Markdown text={text()} />
                      </Show>
                      <Show when={(revisions()?.revisions.length ?? 0) > 0}>
                        <div class="mt-8 border-t border-line pt-4">
                          <div class="label mb-2">Earlier versions</div>
                          <div class="flex flex-col">
                            <For each={revisions()?.revisions ?? []}>
                              {(revision) => (
                                <button
                                  type="button"
                                  class="flex items-center gap-2 border-b border-line-inner py-2 text-left text-[12px] hover:text-fg"
                                  classList={{ "text-accent-text": viewing() === revision.sha256, "text-fg-3": viewing() !== revision.sha256 }}
                                  onClick={() => setViewing(revision.sha256)}
                                >
                                  <Icon name="file" size={13} />
                                  <span class="font-mono text-[10.5px]">{revision.sha256.slice(0, 12)}</span>
                                  <span>{ago(revision.at)}</span>
                                  <span class="ml-auto font-mono text-[10.5px] text-fg-4">{bytes(revision.size)}</span>
                                </button>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </article>
                  )}
                </Show>
              )}
            </Show>
          </Skullet>
        </div>
      </section>

      <Show when={wide()}>
        <aside class="flex w-[320px] shrink-0 flex-col border-l border-line bg-surface">
          <div class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5">
            <span class="label">Files</span>
            <span class="font-mono text-[11px] text-fg-4">{files()?.length ?? 0}</span>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto">
            <For each={files() ?? []}>
              {(entry) => (
                <button
                  type="button"
                  class="flex w-full items-center gap-2.5 border-b border-line px-3 py-2.5 text-left hover:bg-hover"
                  classList={{ "bg-selected": entry.path === props.path }}
                  onClick={() => {
                    setViewing(undefined)
                    navigate(`/p/${props.project.slug}/files/${encodeURIComponent(entry.path)}`)
                  }}
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[12.5px] text-fg">{name(entry.path)}</span>
                    <span class="block truncate text-[11px] text-fg-4">{folder(entry.path, root())}</span>
                  </span>
                  <span class="mono-meta shrink-0">{bytes(entry.size)}</span>
                </button>
              )}
            </For>
          </div>
          <div class="shrink-0 p-3">
            <label
              class="flex flex-col items-center gap-1 rounded-[4px] border border-dashed px-3 py-4 text-center text-[11.5px] text-fg-4"
              classList={{ "border-accent-line text-accent-text": dropping(), "border-line-inner": !dropping() }}
              onDragOver={(event) => {
                event.preventDefault()
                setDropping(true)
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDropping(false)
                const dropped = event.dataTransfer?.files
                if (dropped !== undefined && dropped.length > 0) void upload(dropped)
              }}
            >
              <Icon name="upload" size={16} />
              <span>Drop a file here</span>
              <span class="text-[10.5px]">It lands in this project's folder</span>
              <input
                type="file"
                multiple
                class="hidden"
                onChange={(event) => {
                  const picked = event.currentTarget.files
                  if (picked !== null && picked.length > 0) void upload(picked)
                }}
              />
            </label>
          </div>
        </aside>
      </Show>
    </div>
  )
}
