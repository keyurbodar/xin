import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { keyStarted } from "../../lib/motion.ts"
import { errorMessage, putSkill, skills } from "../../state/extensions.ts"
import { skillEntry, type SkillEntry } from "../../state/explore.ts"
import { Button, Failure } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Card, DetailColumns, Fact, LoadFailed, Page, SkeletonRows } from "./parts.tsx"
import { crumbsFor } from "./routes.ts"

const GRANTS: readonly { readonly title: string; readonly detail: string }[] = [
  {
    title: "Instructions the agent follows with your rights",
    detail: "The agent reads it when a task matches, and acts with the tools it already has.",
  },
  { title: "No scripts, nothing runs on your machines", detail: "It is one Markdown file; it adds no tools and no code." },
  { title: "Stored in your Drive", detail: "It is saved as skills/<name>/SKILL.md, where you can edit or delete it." },
]

const bodyOf = (markdown: string): string => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim()

export function SkillDetail(props: { name: string }): JSX.Element {
  const [entry, { refetch }] = createResource(() => props.name, skillEntry)
  const ready = () => (entry.state === "ready" || entry.state === "refreshing" ? entry.latest : undefined)
  const [sheet, setSheet] = createSignal(false)
  onMount(() => void skills.reload())
  const added = createMemo(() => {
    const state = skills.state()
    return state.kind === "ready" && state.value.some((skill) => skill.name === props.name)
  })

  return (
    <Page crumbs={crumbsFor("skills", ready()?.title ?? props.name)} wide>
      <Show when={entry.state === "pending"}>
        <SkeletonRows count={4} />
      </Show>
      <Show when={entry.state === "errored"}>
        <LoadFailed what={props.name} message={errorMessage(entry.error)} onRetry={() => void refetch()} />
      </Show>
      <Show when={ready()}>
        {(skill) => (
          <DetailColumns
            main={
              <>
                <div class="flex items-start gap-4">
                  <span class="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-ink shadow-ring">
                    <Glyph name="book-open" size={22} />
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-3">
                      <h1 class="min-w-0 text-xl font-normal text-ink">{skill().title}</h1>
                      <AddState added={added()} onAdd={() => setSheet(true)} />
                    </div>
                    <p class="mt-1.5 text-sm leading-relaxed text-ink-2">{skill().description}</p>
                  </div>
                </div>

                <section class="relative overflow-hidden rounded-lg bg-card p-4 shadow-ring">
                  <span class="ex-halftone pointer-events-none absolute inset-y-0 right-0 w-3/5" aria-hidden="true" />
                  <div class="relative flex flex-col gap-3">
                    <h2 class="text-sm font-medium text-ink">Set up {skill().title}</h2>
                    <div class="flex flex-col gap-3 rounded-md bg-panel px-3.5 py-3 shadow-ring sm:flex-row sm:items-center">
                      <span class="min-w-0 flex-1">
                        <span class="block text-sm text-ink">Add to your skills</span>
                        <span class="block text-xs text-ink-2">Saved to your Drive and offered to every conversation</span>
                      </span>
                      <AddState added={added()} onAdd={() => setSheet(true)} />
                    </div>
                  </div>
                </section>

                <Card title="1 file">
                  <div class="flex items-center gap-3 px-4 py-2.5">
                    <Glyph name="file-code" size={14} class="shrink-0 text-ink-2" />
                    <code class="min-w-0 flex-1 truncate font-mono text-sm text-ink">skills/{skill().name}/SKILL.md</code>
                    <span class="shrink-0 text-xs text-ink-2">{skill().lines} lines</span>
                  </div>
                  <pre class="max-h-[360px] overflow-auto border-t border-line-1 bg-bg px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
                    {bodyOf(skill().markdown)}
                  </pre>
                </Card>

                <Card title="1 version">
                  <div class="flex items-center gap-3 px-4 py-2.5">
                    <span class="font-mono text-sm text-ink">1</span>
                    <span class="text-xs text-ink-2">Bundled with this build and pinned by sha256 when the build is made</span>
                  </div>
                </Card>
              </>
            }
            side={
              <>
                <Fact label="Made by">{skill().author}</Fact>
                <Fact label="Category">{skill().category}</Fact>
                <Fact label="Version">1</Fact>
                <Fact label="Permissions">
                  <ul class="flex list-disc flex-col gap-1 pl-4 text-ink-2">
                    <li>Instructions the agent follows with your rights</li>
                    <li>No scripts, nothing runs on your machines</li>
                  </ul>
                </Fact>
                <a
                  href={`mailto:?subject=${encodeURIComponent(`Report: ${skill().name} skill`)}`}
                  class="pt-1 text-sm text-ink-2 hover:text-ink"
                >
                  Report
                </a>
              </>
            }
          />
        )}
      </Show>
      <Show when={sheet() && ready()}>{(skill) => <SkillSheet skill={skill()} onClose={() => setSheet(false)} />}</Show>
    </Page>
  )
}

function AddState(props: { added: boolean; onAdd: () => void }): JSX.Element {
  return (
    <Show
      when={!props.added}
      fallback={
        <span class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm text-ink-2 shadow-ring">
          <Glyph name="check" size={13} />
          Added
        </span>
      }
    >
      <Button size="sm" variant="primary" onClick={props.onAdd}>
        <Glyph name="plus" size={13} />
        Add
      </Button>
    </Show>
  )
}

/** The consent sheet for a skill: what adding it grants, then one `skill.put` of the verified markdown. */
function SkillSheet(props: { skill: SkillEntry; onClose: () => void }): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [done, setDone] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [closing, setClosing] = createSignal(false)
  const close = (): void => {
    if (closing()) return
    setClosing(true)
    setTimeout(props.onClose, keyStarted() ? 0 : 180)
  }
  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const add = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const fresh = await skillEntry(props.skill.name)
      await putSkill(fresh.markdown)
      setDone(true)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        class="im-scrim absolute inset-0 bg-scrim"
        data-state={closing() ? "closed" : "open"}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Add ${props.skill.title}`}
        class="im-sheet absolute inset-y-0 right-0 flex w-full max-w-[480px] flex-col bg-card shadow-overlay"
        data-side="right"
        data-state={closing() ? "closed" : "open"}
      >
        <header class="flex items-center gap-3 border-b border-line-1 px-5 py-4">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary-ink">
            <Glyph name="book-open" size={17} />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-base font-medium text-ink">Add {props.skill.title}</h2>
            <span class="block truncate text-sm text-ink-2">Skill · by {props.skill.author}</span>
          </div>
          <button type="button" onClick={close} aria-label="Close" class="text-ink-2 hover:text-ink">
            <Glyph name="x" size={16} />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Show
            when={!done()}
            fallback={
              <div class="flex flex-col gap-2" role="status">
                <span class="flex items-center gap-2 text-base text-ink">
                  <Glyph name="check" size={15} class="text-done" />
                  Added to your skills
                </span>
                <span class="text-sm text-ink-2">
                  The agent sees it from the next turn. Edit or remove it under Extensions › Customize › Skills.
                </span>
              </div>
            }
          >
            <span class="mb-2 block text-sm text-ink-2">Adding this skill grants</span>
            <div class="overflow-hidden rounded-md shadow-ring">
              <For each={GRANTS}>
                {(grant) => (
                  <div class="flex flex-col gap-0.5 border-b border-line-1 px-3.5 py-2.5 last:border-0">
                    <span class="text-sm text-ink">{grant.title}</span>
                    <span class="text-xs text-ink-2">{grant.detail.replace("<name>", props.skill.name)}</span>
                  </div>
                )}
              </For>
            </div>
            <p class="mt-3 text-xs text-ink-2">It ships inside this build, and its content is pinned by sha256 when the build is made.</p>
            <Show when={error()}>{(message) => <div class="mt-3"><Failure message={message()} /></div>}</Show>
          </Show>
        </div>
        <footer class="flex items-center justify-end gap-2 border-t border-line-1 px-5 py-3">
          <Button size="sm" variant="quiet" onClick={close}>
            {done() ? "Close" : "Cancel"}
          </Button>
          <Show when={!done()}>
            <Button size="sm" variant="primary" disabled={busy()} onClick={() => void add()}>
              {busy() ? "Adding" : "Add skill"}
            </Button>
          </Show>
        </footer>
      </section>
    </div>
  )
}
