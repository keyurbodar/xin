import { createResource, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Popover } from "@ark-ui/solid/popover"
import { Plus, X } from "lucide-solid"
import {
  assigneeCandidates,
  issueIdOf,
  LINK_KINDS,
  LINK_LABEL,
  linkedIds,
  type Assignee,
  type Candidate,
  type Edit,
  type IssueDetail,
  type LinkKind,
} from "../../lib/issues.ts"
import { searchIssues } from "../../state/issues.ts"
import { Button } from "../ui/button.tsx"
import { ICON_BUTTON, MENU_CONTENT } from "../shell/menu.ts"
import { AssigneeChip } from "./issue-marks.tsx"

function messageOf(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem)
}

/** One write at a time per issue view, with the failure kept beside the field that caused it. */
export type FieldAction = {
  readonly busy: Accessor<string | undefined>
  readonly error: (key: string) => string | undefined
  readonly run: (key: string, work: () => Promise<void>) => Promise<boolean>
  readonly send: (key: string, edit: Edit, write: (fields: Record<string, unknown>) => Promise<void>) => Promise<boolean>
}

export function createFieldAction(): FieldAction {
  const [busy, setBusy] = createSignal<string>()
  const [failure, setFailure] = createSignal<{ readonly key: string; readonly message: string }>()
  const run = async (key: string, work: () => Promise<void>): Promise<boolean> => {
    if (busy() !== undefined) return false
    setBusy(key)
    setFailure(undefined)
    try {
      await work()
      return true
    } catch (problem) {
      setFailure({ key, message: messageOf(problem) })
      return false
    } finally {
      setBusy(undefined)
    }
  }
  return {
    busy,
    error: (key) => (failure()?.key === key ? failure()?.message : undefined),
    run,
    send: async (key, edit, write) => {
      switch (edit.kind) {
        case "same":
          setFailure(undefined)
          return true
        case "invalid":
          setFailure({ key, message: edit.message })
          return false
        case "send":
          return run(key, () => write(edit.fields))
        default: {
          const _exhaustive: never = edit
          return _exhaustive
        }
      }
    },
  }
}

export function FieldError(props: { message: string | undefined }): JSX.Element {
  return (
    <Show when={props.message}>
      {(message) => (
        <span role="alert" class="block px-1.5 pt-0.5 text-xs text-failed">
          {message()}
        </span>
      )}
    </Show>
  )
}

const INPUT =
  "w-full rounded-sm border border-line-2 bg-panel px-2 text-sm text-ink outline-none placeholder:text-placeholder focus:border-line-3"

export function TitleField(props: { value: string; busy: boolean; onSave: (draft: string) => Promise<boolean> }): JSX.Element {
  const [editing, setEditing] = createSignal(false)
  const save = async (draft: string): Promise<void> => {
    if (await props.onSave(draft)) setEditing(false)
  }
  return (
    <Show
      when={editing()}
      fallback={
        <button
          type="button"
          class="im-hover -mx-1 rounded-sm px-1 text-left text-lg font-medium text-ink"
          title="Edit the title"
          onClick={() => setEditing(true)}
        >
          {props.value}
        </button>
      }
    >
      <input
        ref={(element) => queueMicrotask(() => element.select())}
        value={props.value}
        maxLength={300}
        aria-label="Title"
        disabled={props.busy}
        class={`${INPUT} h-8 text-lg font-medium`}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save(event.currentTarget.value)
          if (event.key === "Escape") setEditing(false)
        }}
        onBlur={(event) => void save(event.currentTarget.value)}
      />
    </Show>
  )
}

export function DescriptionField(props: { value: string; busy: boolean; onSave: (draft: string) => Promise<boolean> }): JSX.Element {
  const [draft, setDraft] = createSignal<string>()
  const save = async (): Promise<void> => {
    const text = draft()
    if (text !== undefined && (await props.onSave(text))) setDraft(undefined)
  }
  return (
    <Show
      when={draft() !== undefined}
      fallback={
        <button
          type="button"
          title="Edit the description"
          class="im-hover mx-1 whitespace-pre-wrap break-words rounded-sm px-1 py-0.5 text-left text-sm leading-[1.55] text-ink-2"
          onClick={() => setDraft(props.value)}
        >
          {props.value === "" ? <span class="text-ink-3">Add a description</span> : props.value}
        </button>
      }
    >
      <div class="mx-2 flex flex-col gap-2">
        <textarea
          ref={(element) => queueMicrotask(() => element.focus())}
          value={draft() ?? ""}
          rows={6}
          maxLength={20_000}
          aria-label="Description"
          disabled={props.busy}
          class={`${INPUT} resize-y py-1.5 leading-[1.55]`}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void save()
            }
            if (event.key === "Escape") setDraft(undefined)
          }}
        />
        <div class="flex justify-end gap-1.5">
          <Button variant="quiet" size="sm" onClick={() => setDraft(undefined)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={props.busy} onClick={() => void save()}>
            {props.busy ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </Show>
  )
}

export function DueField(props: {
  value: string | null
  label: string | undefined
  overdue: boolean
  busy: boolean
  onSave: (value: string) => Promise<boolean>
}): JSX.Element {
  return (
    <span class="flex h-7 items-center gap-1">
      <input
        type="date"
        aria-label="Due date"
        value={props.value ?? ""}
        disabled={props.busy}
        class="im-hover h-7 rounded-sm bg-transparent px-1.5 text-sm outline-none [color-scheme:inherit]"
        classList={{ "text-failed": props.overdue, "text-ink": !props.overdue && props.value !== null, "text-ink-3": props.value === null }}
        title={props.label}
        onChange={(event) => void props.onSave(event.currentTarget.value)}
      />
      <Show when={props.value !== null}>
        <button type="button" class="link text-xs text-ink-3" disabled={props.busy} onClick={() => void props.onSave("")}>
          Clear
        </button>
      </Show>
    </span>
  )
}

export function AssigneesField(props: {
  assignees: readonly Assignee[]
  name: (assignee: Assignee) => string
  candidates: readonly Candidate[]
  busy: boolean
  onAdd: (assignee: Assignee) => Promise<boolean>
  onRemove: (assignee: Assignee) => Promise<boolean>
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const matches = () => assigneeCandidates(props.candidates, props.assignees, query())
  return (
    <span class="flex min-h-7 flex-wrap items-center gap-x-1 gap-y-1">
      <For each={props.assignees}>
        {(assignee) => (
          <span class="group flex h-6 items-center gap-1.5 rounded-sm pl-1 pr-0.5 text-ink hover:bg-secondary">
            <AssigneeChip names={[props.name(assignee)]} />
            <span class="max-w-[160px] truncate">{props.name(assignee)}</span>
            <button
              type="button"
              aria-label={`Unassign ${props.name(assignee)}`}
              disabled={props.busy}
              class="grid h-5 w-5 place-items-center rounded-xs text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => void props.onRemove(assignee)}
            >
              <X size={12} stroke-width={1.5} />
            </button>
          </span>
        )}
      </For>
      <Popover.Root
        open={open()}
        onOpenChange={(details) => {
          setOpen(details.open)
          if (!details.open) setQuery("")
        }}
        lazyMount
        unmountOnExit
        positioning={{ placement: "bottom-start", gutter: 4 }}
      >
        <Popover.Trigger class={`${ICON_BUTTON} h-6 w-6`} aria-label="Add an assignee" disabled={props.busy}>
          <Plus size={14} stroke-width={1.5} />
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content class={`${MENU_CONTENT} w-[260px] p-0`}>
              <div class="border-b border-line-1 px-3 py-2">
                <input
                  autofocus
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    const first = matches()[0]
                    if (event.key === "Enter" && first !== undefined) {
                      setOpen(false)
                      void props.onAdd(first.assignee)
                    }
                  }}
                  placeholder="Assign a person, thread or Captain"
                  aria-label="Search assignees"
                  class="h-6 w-full bg-transparent text-sm text-ink outline-none placeholder:text-placeholder"
                />
              </div>
              <div class="flex max-h-[260px] flex-col overflow-y-auto p-1">
                <For each={matches()} fallback={<span class="px-2 py-1.5 text-sm text-ink-3">No one matches</span>}>
                  {(candidate) => (
                    <button
                      type="button"
                      class="im-hover flex h-8 items-center gap-2 rounded-sm px-2 text-left text-sm text-ink"
                      onClick={() => {
                        setOpen(false)
                        void props.onAdd(candidate.assignee)
                      }}
                    >
                      <AssigneeChip names={[candidate.name]} />
                      <span class="min-w-0 flex-1 truncate">{candidate.name}</span>
                      <span class="shrink-0 text-xs text-ink-3">{candidate.detail}</span>
                    </button>
                  )}
                </For>
              </div>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
    </span>
  )
}

const SEARCH_DELAY_MS = 250

/** Add a link by typing an id or searching this project's issues; each pick is one issue.link. */
export function AddLink(props: {
  project: string
  detail: IssueDetail
  busy: boolean
  onLink: (kind: LinkKind, other: number) => Promise<boolean>
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [kind, setKind] = createSignal<LinkKind>("related")
  const [query, setQuery] = createSignal("")
  const [settled, setSettled] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const typed = (text: string): void => {
    setQuery(text)
    clearTimeout(timer)
    timer = setTimeout(() => setSettled(text.trim()), SEARCH_DELAY_MS)
  }
  const [found] = createResource(
    () => {
      const text = settled()
      return open() && text.length >= 2 && issueIdOf(text) === undefined ? text : false
    },
    (text) => searchIssues(props.project, text),
  )
  const taken = () => linkedIds(props.detail.links)
  const results = () => (found.latest ?? []).filter((issue) => issue.id !== props.detail.issue.id && !taken().has(issue.id))
  const direct = () => issueIdOf(query())
  const searchNote = (): string | undefined => {
    if (settled().length < 2) return "Type at least two letters, or an issue id"
    if (found.loading) return "Searching"
    return results().length === 0 ? "No issues match" : undefined
  }
  const pick = async (other: number): Promise<void> => {
    if (await props.onLink(kind(), other)) {
      setOpen(false)
      setQuery("")
      setSettled("")
    }
  }
  return (
    <Popover.Root
      open={open()}
      onOpenChange={(details) => setOpen(details.open)}
      lazyMount
      unmountOnExit
      positioning={{ placement: "bottom-start", gutter: 4 }}
    >
      <Popover.Trigger class="link mx-2 mt-1 flex items-center gap-1 self-start text-xs text-ink-3" disabled={props.busy}>
        <Plus size={12} stroke-width={1.5} />
        Add a link
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content class={`${MENU_CONTENT} w-[300px] p-0`}>
            <div class="flex gap-1 border-b border-line-1 px-2 py-2" role="radiogroup" aria-label="Link kind">
              <For each={LINK_KINDS}>
                {(entry) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={kind() === entry}
                    class="im-press h-7 rounded-sm border px-2 text-xs"
                    classList={{
                      "border-line-3 bg-hover text-ink": kind() === entry,
                      "border-line-1 text-ink-2 hover:bg-secondary": kind() !== entry,
                    }}
                    onClick={() => setKind(entry)}
                  >
                    {LINK_LABEL[entry]}
                  </button>
                )}
              </For>
            </div>
            <div class="border-b border-line-1 px-3 py-2">
              <input
                autofocus
                value={query()}
                onInput={(event) => typed(event.currentTarget.value)}
                onKeyDown={(event) => {
                  const id = direct() ?? results()[0]?.id
                  if (event.key === "Enter" && id !== undefined) void pick(id)
                }}
                placeholder="Search issues or type #id"
                aria-label="Find an issue to link"
                class="h-6 w-full bg-transparent text-sm text-ink outline-none placeholder:text-placeholder"
              />
            </div>
            <div class="flex max-h-[240px] flex-col overflow-y-auto p-1">
              <Show when={direct()}>
                {(id) => (
                  <button type="button" class="im-hover flex h-8 items-center gap-2 rounded-sm px-2 text-left text-sm text-ink" onClick={() => void pick(id())}>
                    <span class="font-mono text-2xs text-ink-3">#{id()}</span>
                    <span class="truncate">
                      {LINK_LABEL[kind()]} #{id()}
                    </span>
                  </button>
                )}
              </Show>
              <For each={direct() === undefined ? results() : []}>
                {(issue) => (
                  <button
                    type="button"
                    class="im-hover flex h-8 items-center gap-2 rounded-sm px-2 text-left text-sm text-ink"
                    onClick={() => void pick(issue.id)}
                  >
                    <span class="shrink-0 font-mono text-2xs text-ink-3">#{issue.id}</span>
                    <span class="min-w-0 flex-1 truncate">{issue.title}</span>
                  </button>
                )}
              </For>
              <Show when={direct() === undefined ? searchNote() : undefined}>
                {(note) => <span class="px-2 py-1.5 text-xs text-ink-3">{note()}</span>}
              </Show>
            </div>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  )
}
