import { createResource, createSignal, For, Show, type JSX } from "solid-js"
import { errorMessage, putSkill, readSkill, removeSkill, skills } from "../../state/extensions.ts"
import { Button, Empty, Failure, Note, Panel, Pending, failureOf } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

export function Skills(): JSX.Element {
  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const [creating, setCreating] = createSignal(false)

  const list = () => {
    const state = skills.state()
    return state.kind === "ready" ? state.value : []
  }

  const current = () => list().find((skill) => skill.name === selected())

  return (
    <>
      <div class="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <span class="label">Skills</span>
          <Button
            size="sm"
            class="ml-auto"
            onClick={() => {
              setCreating(true)
              setSelected(undefined)
            }}
          >
            <Glyph name="plus" size={14} />
            New
          </Button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={skills.state().kind === "loading"}>
            <Pending label="Reading skills" />
          </Show>
          <Show when={skills.state().kind === "ready"}>
            <Show
              when={list().length > 0}
              fallback={
                <div class="p-3">
                  <Empty title="No skills." detail="A skill is a markdown note with a short header that tells threads when to load it." />
                </div>
              }
            >
              <For each={list()}>
                {(skill) => (
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(skill.name)
                      setCreating(false)
                    }}
                    class="flex w-full items-start gap-2.5 border-b border-line px-3.5 py-3 text-left hover:bg-hover"
                    classList={{ "bg-hover": selected() === skill.name }}
                  >
                    <Glyph name="book-open" size={15} class="mt-0.5 shrink-0 text-fg-3" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[12.5px] font-medium text-fg">{skill.name}</span>
                      <span class="line-clamp-2 block text-[11.5px] leading-snug text-fg-3">{skill.description}</span>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
          <Show when={failureOf(skills.state())}>
            {(message) => (
              <div class="p-3">
                <Failure message={message()} onRetry={() => void skills.reload()} />
              </div>
            )}
          </Show>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <Show
          when={creating()}
          fallback={
            <Show
              when={current()}
              fallback={
                <div class="px-6 py-6">
                  <Empty title="Pick a skill or write one." detail="Skills are markdown with frontmatter naming the skill and when it applies." />
                </div>
              }
            >
              {(skill) => (
                <SkillDetail
                  name={skill().name}
                  description={skill().description}
                  onRemoved={() => setSelected(undefined)}
                />
              )}
            </Show>
          }
        >
          <NewSkill onCreated={(name) => { setCreating(false); setSelected(name) }} onCancel={() => setCreating(false)} />
        </Show>
      </div>
    </>
  )
}

function SkillDetail(props: { name: string; description: string; onRemoved: () => void }): JSX.Element {
  const [body, { refetch }] = createResource(() => props.name, readSkill)
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")

  const startEditing = (): void => {
    setDraft(body()?.markdown ?? "")
    setEditing(true)
  }

  /** A stored copy wins over a package's, so saving the same name is what the mockup calls a fork. */
  const saveSkill = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await putSkill(draft())
      await refetch()
      setEditing(false)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await removeSkill(props.name)
      props.onRemoved()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header class="flex items-center gap-3 border-b border-line px-6 py-4">
        <Glyph name="book-open" size={16} class="text-fg-3" />
        <div class="min-w-0 flex-1">
          <span class="block truncate text-[16px] font-medium text-fg">{props.name}.md</span>
          <span class="block truncate text-[12px] text-fg-3">{props.description}</span>
        </div>
        <Show when={editing()}>
          <Button size="sm" variant="primary" disabled={busy() || draft().trim() === ""} onClick={() => void saveSkill()}>
            {busy() ? "Saving" : "Save"}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>Cancel</Button>
        </Show>
        <Show when={!editing()}>
          <Button size="sm" variant="quiet" onClick={startEditing}>
            <Glyph name="pencil" size={14} />
            Edit
          </Button>
        </Show>
        <Show
          when={confirming()}
          fallback={
            <Show when={!editing()}>
              <Button size="sm" variant="quiet" onClick={() => setConfirming(true)}>
                <Glyph name="trash" size={14} />
                Delete
              </Button>
            </Show>
          }
        >
          <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
          <Button size="sm" variant="danger" disabled={busy()} onClick={() => void remove()}>{busy() ? "Deleting" : "Delete skill"}</Button>
        </Show>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div class="flex max-w-[640px] flex-col gap-4">
          <Show when={error()}>
            {(message) => <Failure message={message()} />}
          </Show>
          <Show when={body.error}>
            {(failure) => <Failure message={errorMessage(failure())} />}
          </Show>
          <Show
            when={editing()}
            fallback={
              <Show when={body()}>
                {(skill) => (
                  <Panel>
                    <pre class="max-h-[420px] overflow-auto px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-fg-2">
                      {skill().markdown}
                    </pre>
                  </Panel>
                )}
              </Show>
            }
          >
            <Panel>
              <textarea
                value={draft()}
                onInput={(event) => setDraft(event.currentTarget.value)}
                rows={16}
                spellcheck={false}
                aria-label="Skill markdown"
                class="w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-fg outline-none"
              />
            </Panel>
          </Show>
          <Show when={body.loading}>
            <Pending label="Reading the skill" />
          </Show>
          <Note>
            The markdown above is what the model receives, header first: `name` and `description`, then the body. A skill a
            package contributes stays read-only; saving an owner copy with the same name overrides it.
          </Note>
        </div>
      </div>
    </>
  )
}

function NewSkill(props: { onCreated: (name: string) => void; onCancel: () => void }): JSX.Element {
  const [markdown, setMarkdown] = createSignal("---\nname: \ndescription: \n---\n\n# \n")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const named = (): boolean => {
    const match = /^---\r?\n[\s\S]*?\r?\n---/u.exec(markdown().trimStart())
    if (match === null) return false
    return /^name:\s*\S+/mu.test(match[0])
  }

  const submit = async (): Promise<void> => {
    if (busy() || !named()) return
    setBusy(true)
    setError(undefined)
    try {
      const match = /^name:\s*(.+)$/mu.exec(markdown().trimStart())
      const name = match?.[1]?.trim() ?? ""
      await putSkill(markdown())
      props.onCreated(name)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header class="flex items-center gap-3 border-b border-line px-6 py-4">
        <div class="min-w-0 flex-1">
          <span class="block text-[16px] font-medium text-fg">New skill</span>
          <span class="block text-[12px] text-fg-3">Frontmatter names the skill; the body says what it does</span>
        </div>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
        <textarea
          value={markdown()}
          onInput={(event) => setMarkdown(event.currentTarget.value)}
          spellcheck={false}
          class="min-h-0 flex-1 resize-none rounded-[2px] border border-line-inner bg-page p-3 font-mono text-[12px] leading-relaxed text-fg focus:border-line-strong focus:outline-none"
          aria-label="Skill markdown"
        />
        <Show when={error()}>
          {(message) => <Failure message={message()} />}
        </Show>
      </div>
      <footer class="flex items-center gap-2 border-t border-line px-6 py-3">
        <span class="text-[11.5px] text-fg-3">The frontmatter name must match what you type after name:</span>
        <span class="ml-auto" />
        <Button size="sm" variant="quiet" onClick={props.onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={busy() || !named()} onClick={() => void submit()}>{busy() ? "Saving" : "Create skill"}</Button>
      </footer>
    </>
  )
}

