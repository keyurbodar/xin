import { For, Show, createResource, createSignal, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { ago } from "../../lib/format.ts"
import { Icon } from "../ui/icon.tsx"
import { Skullet } from "../ui/skeleton.tsx"
import { createPaneAction, EmptyState, PanelGhost, ResourceError } from "./ui.tsx"

type ListedNote = {
  readonly id: number
  readonly scope: string
  readonly text: string
  readonly at: number
  readonly source: string
  readonly pinned: boolean
}

type Suggestion = { readonly text: string; readonly scope: string }

export function MemoryTab(props: { conversationId: number; scope: string }): JSX.Element {
  const [notes, { refetch }] = createResource(() => cmd<{ readonly notes: readonly ListedNote[] }>("memory.list", {}))
  const [suggestions, { refetch: refetchSuggestions }] = createResource(
    () => props.conversationId,
    (conversationId) =>
      cmd<{ readonly suggestions: readonly Suggestion[] }>("memory.suggested", {
        conversationId,
        scope: props.scope,
      }),
  )
  const action = createPaneAction()
  const [editing, setEditing] = createSignal<number | undefined>()
  const [draft, setDraft] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [fresh, setFresh] = createSignal("")

  const reload = async (): Promise<void> => {
    await Promise.all([refetch(), refetchSuggestions()])
  }

  const mutate = (key: number | "new", op: string, args: Record<string, unknown>): Promise<void> =>
    action.run(key, async () => {
      await cmd(op, args)
      setEditing(undefined)
      await reload()
    })

  const forget = (note: ListedNote): Promise<void> => mutate(note.id, "memory.forget", { id: note.id })
  const pin = (note: ListedNote): Promise<void> => mutate(note.id, "memory.pin", { id: note.id, pinned: !note.pinned })
  const save = async (note: ListedNote): Promise<void> => {
    const text = draft().trim()
    if (text === "" || text === note.text) {
      setEditing(undefined)
      return
    }
    await mutate(note.id, "memory.edit", { id: note.id, text })
  }
  const openEdit = (note: ListedNote): void => {
    setDraft(note.text)
    setEditing(note.id)
  }
  const add = async (): Promise<void> => {
    const text = fresh().trim()
    if (text === "") return
    await action.run("new", async () => {
      await cmd("memory.add", { text, scope: props.scope })
      setFresh("")
      setAdding(false)
      await reload()
    })
  }
  const remember = (suggestion: Suggestion): Promise<void> =>
    action.run("new", async () => {
      await cmd("memory.add", { text: suggestion.text, scope: suggestion.scope })
      await reload()
    })
  const dismiss = (suggestion: Suggestion): Promise<void> =>
    action.run("new", async () => {
      await cmd("memory.dismiss", { text: suggestion.text })
      await refetchSuggestions()
    })

  return (
    <Skullet loading={notes.loading} sample={() => <PanelGhost rows={6} />} label="Loading memory">
      <Show when={notes.error} fallback={null}>
        <ResourceError what="memory" error={notes.error} onRetry={() => void refetch()} />
      </Show>
      <div class="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span class="flex-1 text-[12px] leading-[1.5] text-fg-3">
          What the coordinator keeps between chats. Every thread can read it.
        </span>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 hover:border-line-strong hover:text-fg"
          onClick={() => setAdding((open) => !open)}
        >
          <Icon name="plus" size={13} />
          Add
        </button>
      </div>
      <Show when={adding()}>
        <div class="flex flex-col gap-2 border-b border-line px-3 py-3">
          <textarea
            rows={2}
            autofocus
            placeholder="A fact worth keeping across chats"
            class="w-full resize-none rounded-[3px] border border-line-strong bg-surface px-2 py-1.5 text-[13px] leading-[1.5] text-fg outline-none placeholder:text-fg-4 focus:border-accent-line"
            value={fresh()}
            onInput={(event) => setFresh(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setAdding(false)
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void add()
            }}
          />
          <div class="flex items-center gap-2">
            <button
              type="button"
              disabled={action.busy() === "new" || fresh().trim() === ""}
              class="rounded-[2px] border border-line px-2 py-1 text-[11.5px] text-fg-2 hover:border-line-strong hover:text-fg disabled:opacity-50"
              onClick={() => void add()}
            >
              Remember
            </button>
            <button type="button" class="link text-[11.5px]" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <Show when={action.failed()}>
        {(message) => <div class="border-b border-line px-3 py-2 text-[12px] text-bad">{message()}</div>}
      </Show>
      <For each={suggestions()?.suggestions ?? []}>
        {(suggestion) => (
          <div class="mx-3 mb-3 mt-3 rounded-[4px] border border-accent-line bg-raised p-3">
            <div class="flex items-center gap-2">
              <span class="rounded-[2px] border border-accent-line bg-accent-dim px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-accent-text">
                Suggested
              </span>
              <span class="text-[11.5px] text-fg-3">from your last message</span>
            </div>
            <div class="mt-1.5 text-[13px] leading-[1.5] text-fg">{suggestion.text}</div>
            <div class="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                disabled={action.busy() === "new"}
                class="rounded-[2px] border border-accent bg-accent px-2 py-1 text-[11.5px] font-medium text-ink hover:opacity-90 disabled:opacity-50"
                onClick={() => void remember(suggestion)}
              >
                Remember
              </button>
              <button
                type="button"
                class="rounded-[2px] border border-line px-2 py-1 text-[11.5px] text-fg-2 hover:border-line-strong hover:text-fg"
                onClick={() => {
                  setFresh(suggestion.text)
                  setAdding(true)
                }}
              >
                Edit
              </button>
              <button
                type="button"
                class="rounded-[2px] px-2 py-1 text-[11.5px] text-fg-3 hover:text-fg-2"
                onClick={() => void dismiss(suggestion)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </For>
      <Show when={notes()}>
        {(data) => (
          <Show
            when={data().notes.length > 0}
            fallback={<EmptyState icon="brain" title="Nothing remembered yet" detail="Facts the coordinator keeps between chats appear here." />}
          >
            <div class="flex flex-col">
              <For each={data().notes}>
                {(note) => (
                  <div class="group flex items-start gap-2 border-b border-line px-3 py-3">
                    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Show
                        when={editing() === note.id}
                        fallback={<span class="text-[13px] leading-[1.5] text-fg">{note.text}</span>}
                      >
                        <textarea
                          rows={3}
                          class="w-full resize-none rounded-[3px] border border-line-strong bg-surface px-2 py-1.5 text-[13px] leading-[1.5] text-fg outline-none focus:border-accent-line"
                          value={draft()}
                          onInput={(event) => setDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setEditing(undefined)
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save(note)
                          }}
                        />
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={action.busy() === note.id}
                            class="rounded-[2px] border border-line px-2 py-1 text-[11.5px] text-fg-2 hover:border-line-strong hover:text-fg disabled:opacity-50"
                            onClick={() => void save(note)}
                          >
                            Save
                          </button>
                          <button type="button" class="link text-[11.5px]" onClick={() => setEditing(undefined)}>
                            Cancel
                          </button>
                        </div>
                      </Show>
                      <span class="flex flex-wrap items-center gap-2 text-[11.5px] text-fg-3">
                        <span class="flex items-center gap-1">
                          <Icon name={note.source === "dreamer" ? "brain" : "message"} size={12} class="text-fg-4" />
                          {note.source === "dreamer" ? "Learned by the coordinator" : "You said"}
                        </span>
                        <span class="text-fg-4">·</span>
                        {ago(note.at)}
                        <Show when={note.scope !== "me"}>
                          <span class="rounded-[2px] border border-line-inner px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em]">
                            {note.scope}
                          </span>
                        </Show>
                        <Show when={note.pinned}>
                          <span class="rounded-[2px] border border-accent-line bg-accent-dim px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-accent-text">
                            Pinned
                          </span>
                        </Show>
                      </span>
                    </div>
                    <Show when={editing() !== note.id}>
                      <div class="mt-0.5 flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label={note.pinned ? "Unpin this" : "Pin this"}
                          disabled={action.busy() === note.id}
                          class="rounded-[2px] p-1 hover:bg-hover disabled:opacity-50"
                          classList={{ "text-accent-text": note.pinned, "text-fg-4 hover:text-fg-2": !note.pinned }}
                          onClick={() => void pin(note)}
                        >
                          <Icon name="pin" size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label="Edit this"
                          disabled={action.busy() === note.id}
                          class="rounded-[2px] p-1 text-fg-4 hover:bg-hover hover:text-fg-2 disabled:opacity-50"
                          onClick={() => openEdit(note)}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label="Forget this"
                          disabled={action.busy() === note.id}
                          class="rounded-[2px] p-1 text-fg-4 hover:bg-hover hover:text-fg-2 disabled:opacity-50"
                          onClick={() => void forget(note)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </Skullet>
  )
}
