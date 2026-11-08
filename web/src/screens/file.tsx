import { For, Show, createResource, createSignal, type JSX } from "solid-js"
import { cmd } from "../lib/api.ts"
import { ago, bytes } from "../lib/format.ts"
import { navigate } from "../lib/router.ts"
import { mediaQuery } from "../lib/media.ts"
import type { ProjectSummary } from "../state/home.ts"
import { Markdown } from "../components/chat/markdown.tsx"
import { Skullet } from "../components/ui/skeleton.tsx"
import { EmptyState } from "../components/chat/ui.tsx"

export type FileEntry = {
  readonly path: string
  readonly size: number
  readonly type: string
  readonly sha256: string
  readonly project: string | null
  readonly updated_at: number
}

export type FileContent = FileEntry & { readonly text: string | null }

const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const folder = (path: string, root: string): string => {
  const relative = path.startsWith(root) ? path.slice(root.length) : path
  const cut = relative.lastIndexOf("/")
  return cut === -1 ? "Project root" : relative.slice(0, cut)
}

function download(entry: FileContent): void {
  if (entry.text === null) return
  const link = document.createElement("a")
  link.href = URL.createObjectURL(new Blob([entry.text], { type: entry.type }))
  link.download = name(entry.path)
  link.click()
  URL.revokeObjectURL(link.href)
}

export function FileScreen(props: { project: ProjectSummary; path: string }): JSX.Element {
  const root = (): string => `/projects/${props.project.slug}/`
  const [files] = createResource(
    () => props.project.slug,
    (slug) => cmd<readonly FileEntry[]>("file.list", { prefix: `/projects/${slug}` }),
  )
  const [content] = createResource(
    () => props.path,
    (path) => cmd<FileContent>("file.read", { path }),
  )
  const [copied, setCopied] = createSignal(false)
  const wide = mediaQuery("(min-width: 1024px)")

  const copy = async (): Promise<void> => {
    const text = content()?.text
    if (text === undefined || text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <section class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <button
            type="button"
            class="link truncate text-[13px]"
            onClick={() => navigate(`/p/${props.project.slug}`)}
          >
            {props.project.name}
          </button>
          <span class="text-fg-4">/</span>
          <span class="text-[13px] text-fg-3">Files</span>
          <span class="text-fg-4">/</span>
          <span class="min-w-0 truncate text-[13px] font-medium text-fg">{name(props.path)}</span>
          <Show when={content()}>
            {(entry) => (
              <span class="ml-auto shrink-0 font-mono text-[11.5px] text-fg-4">
                {bytes(entry().size)} · edited {ago(entry().updated_at)}
              </span>
            )}
          </Show>
          <Show when={content()?.text ?? null}>
            <button
              type="button"
              class="shrink-0 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 transition-none hover:border-line-strong hover:text-fg"
              onClick={() => void copy()}
            >
              {copied() ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              class="shrink-0 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 transition-none hover:border-line-strong hover:text-fg"
              onClick={() => {
                const entry = content()
                if (entry !== undefined) download(entry)
              }}
            >
              Download
            </button>
          </Show>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <Skullet loading={content.loading} sample={() => <div class="h-3 w-2/3 rounded-[1px] bg-hover" />} label="Opening file">
            <Show
              when={content()}
              fallback={<EmptyState icon="file" title="File not found" detail="It may have been deleted." />}
            >
              {(entry) => (
                <Show
                  when={entry().text}
                  fallback={
                    <EmptyState
                      icon="file"
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
                        when={entry().type === "text/markdown"}
                        fallback={
                          <pre class="whitespace-pre-wrap font-mono text-[12.5px] leading-[1.6] text-fg-2">
                            {text()}
                          </pre>
                        }
                      >
                        <Markdown text={text()} />
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
                  class="flex w-full items-center gap-2.5 border-b border-line px-3 py-2.5 text-left transition-none hover:bg-hover"
                  classList={{ "bg-selected": entry.path === props.path }}
                  onClick={() => navigate(`/p/${props.project.slug}/files/${encodeURIComponent(entry.path)}`)}
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
        </aside>
      </Show>
    </div>
  )
}
