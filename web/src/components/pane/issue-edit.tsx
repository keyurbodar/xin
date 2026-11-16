import "@ui-sdk/web/command"
import "@ui-sdk/web/popover"
import "@ui-sdk/web/segmented-control"
import { createResource, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Plus, X } from "lucide-solid"
import {
  assigneeCandidates,
  issueIdOf,
  LINK_KINDS,
  LINK_LABEL,
  LINK_QUERY_MAX,
  linkedIds,
  linkQuery,
  outsideProject,
  type Assignee,
  type Candidate,
  type Edit,
  type IssueDetail,
  type LinkKind,
} from "../../lib/issues.ts"
import { createFocusReturn, type EditorExit } from "../../lib/focus.ts"
import { searchIssues } from "../../state/issues.ts"
import { Button } from "../ui/button.tsx"
import { ICON_BUTTON } from "../shell/menu.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM } from "../ui/surface.ts"
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
  const focus = createFocusReturn()
  const close = (how: EditorExit): void => {
    setEditing(false)
    focus.exit(how)
  }
  const save = async (draft: string, how: EditorExit): Promise<void> => {
    if (await props.onSave(draft)) close(how)
  }
  return (
    <Show
      when={editing()}
      fallback={
        <button
          ref={focus.trigger}
          type="button"
          class="im-hover -mx-1 rounded-sm px-1 text-left text-title-sm font-title text-ink"
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
        class={`${INPUT} h-8 text-title-sm font-title`}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            void save(event.currentTarget.value, "key")
          }
          if (event.key === "Escape") close("key")
        }}
        onBlur={(event) => {
          if (editing()) void save(event.currentTarget.value, "blur")
        }}
      />
    </Show>
  )
}

export function DescriptionField(props: { value: string; busy: boolean; onSave: (draft: string) => Promise<boolean> }): JSX.Element {
  const [draft, setDraft] = createSignal<string>()
  const focus = createFocusReturn()
  const close = (how: EditorExit): void => {
    setDraft(undefined)
    focus.exit(how)
  }
  const save = async (how: EditorExit): Promise<void> => {
    const text = draft()
    if (text !== undefined && (await props.onSave(text))) close(how)
  }
  return (
    <Show
      when={draft() !== undefined}
      fallback={
        <button
          ref={focus.trigger}
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
              void save("key")
            }
            if (event.key === "Escape") close("key")
          }}
        />
        <div class="flex justify-end gap-1.5">
          <Button variant="quiet" size="sm" onClick={() => close("button")}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={props.busy} onClick={() => void save("button")}>
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
    <span class="-mx-1.5 flex h-7 items-center gap-1">
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

const assigneeKey = (assignee: Assignee): string => `${assignee.kind}:${assignee.id}`

export function AssigneesField(props: {
  assignees: readonly Assignee[]
  name: (assignee: Assignee) => string
  candidates: readonly Candidate[]
  busy: boolean
  onAdd: (assignee: Assignee) => Promise<boolean>
  onRemove: (assignee: Assignee) => Promise<boolean>
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const content = createOverlayMount(open)
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
      <ui-popover
        prop:open={open()}
        on:openchange={(event) => {
          event.preventDefault()
          const next = event.detail.value
          if (next && props.busy) return
          if (!next) setQuery("")
          queueMicrotask(() => setOpen(next))
        }}
        on:openchangecomplete={content.settle}
      >
        <ui-popover-trigger>
          <button
            type="button"
            class={`${ICON_BUTTON} h-6 w-6 aria-expanded:bg-hover aria-expanded:text-ink aria-disabled:opacity-50`}
            aria-label="Add an assignee"
            title="Add an assignee"
            aria-disabled={props.busy ? "true" : undefined}
          >
            <Plus size={14} stroke-width={1.5} />
          </button>
        </ui-popover-trigger>
        <ui-popover-content side="bottom" align="start" side-offset="4" class={`${POPUP} w-[260px] p-0`}>
          <Show when={content.mounted()}>
            <ui-popover-title class="sr-only">Add an assignee</ui-popover-title>
            <ui-command
              filter="false"
              auto-highlight
              on:action={(event) => {
                const chosen = matches().find((candidate) => assigneeKey(candidate.assignee) === event.detail.value)
                if (chosen === undefined) return
                setOpen(false)
                setQuery("")
                void props.onAdd(chosen.assignee)
              }}
              class="flex flex-col"
            >
              <div class="border-b border-line-1 px-3 py-2">
                <ui-command-input>
                  <input
                    autofocus
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Assign a person, thread or Captain"
                    aria-label="Search assignees"
                    class="h-6 w-full bg-transparent text-small text-ink outline-none placeholder:text-placeholder"
                  />
                </ui-command-input>
              </div>
              <ui-command-list class="flex max-h-[260px] flex-col overflow-y-auto p-1">
                <For each={matches()} fallback={<span class="px-2 py-1.5 text-small text-ink-3">No one matches</span>}>
                  {(candidate) => (
                    <ui-command-item value={assigneeKey(candidate.assignee)} label={candidate.name} class={POPUP_ITEM}>
                      <AssigneeChip names={[candidate.name]} />
                      <span class="min-w-0 flex-1 truncate">{candidate.name}</span>
                      <span class="shrink-0 text-mini text-ink-3">{candidate.detail}</span>
                    </ui-command-item>
                  )}
                </For>
              </ui-command-list>
            </ui-command>
          </Show>
        </ui-popover-content>
      </ui-popover>
    </span>
  )
}

const SEARCH_DELAY_MS = 250

/** Add a link by typing an id or searching this project's issues; each pick is one issue.link. */
export function AddLink(props: {
  project: string
  detail: IssueDetail
  busy: boolean
  error: string | undefined
  onLink: (kind: LinkKind, other: number) => Promise<boolean>
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const content = createOverlayMount(open)
  const [kind, setKind] = createSignal<LinkKind>("related")
  const [query, setQuery] = createSignal("")
  const [settled, setSettled] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const typed = (text: string): void => {
    setQuery(text)
    clearTimeout(timer)
    timer = setTimeout(() => setSettled(linkQuery(text)), SEARCH_DELAY_MS)
  }
  const [found] = createResource(
    () => {
      const text = settled()
      return open() && text.length >= 2 && issueIdOf(text) === undefined ? text : false
    },
    (text) => searchIssues(props.project, text),
  )
  const taken = () => linkedIds(props.detail.links)
  const results = () =>
    ((found.error === undefined ? found.latest : undefined) ?? []).filter(
      (issue) => outsideProject(issue, props.project) === undefined && issue.id !== props.detail.issue.id && !taken().has(issue.id),
    )
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
    <ui-popover
      prop:open={open()}
      on:openchange={(event) => {
        event.preventDefault()
        const next = event.detail.value
        if (next && props.busy) return
        queueMicrotask(() => setOpen(next))
      }}
      on:openchangecomplete={content.settle}
    >
      <ui-popover-trigger>
        <button
          type="button"
          class="link mx-2 mt-1 flex items-center gap-1 self-start text-mini text-ink-3 aria-disabled:opacity-50"
          aria-disabled={props.busy ? "true" : undefined}
        >
          <Plus size={12} stroke-width={1.5} />
          Add a link
        </button>
      </ui-popover-trigger>
      <ui-popover-content side="bottom" align="start" side-offset="4" class={`${POPUP} w-[300px] p-0`}>
        <Show when={content.mounted()}>
          <ui-popover-title class="sr-only">Add a link</ui-popover-title>
          <div class="border-b border-line-1 p-2">
            <ui-segmented-control
              aria-label="Link kind"
              prop:value={kind()}
              on:valuechange={(event) => {
                const next = LINK_KINDS.find((entry) => entry === event.detail.value)
                if (next !== undefined) setKind(next)
              }}
              class="grid grid-cols-3 gap-0.5 rounded-sm border border-line-1 p-0.5"
            >
              <For each={LINK_KINDS}>
                {(entry) => (
                  <ui-segmented-control-item
                    value={entry}
                    class="im-press flex h-6 cursor-default items-center justify-center rounded-xs text-mini text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-primary-soft data-[checked]:bg-hover data-[checked]:text-ink"
                  >
                    {LINK_LABEL[entry]}
                  </ui-segmented-control-item>
                )}
              </For>
            </ui-segmented-control>
          </div>
          <ui-command
            filter="false"
            auto-highlight
            on:action={(event) => {
              const other = Number(event.detail.value)
              if (Number.isInteger(other)) void pick(other)
            }}
            class="flex flex-col"
          >
            <div class="border-b border-line-1 px-3 py-2">
              <ui-command-input>
                <input
                  autofocus
                  value={query()}
                  onInput={(event) => typed(event.currentTarget.value)}
                  maxLength={LINK_QUERY_MAX}
                  placeholder="Search issues or type #id"
                  aria-label="Find an issue to link"
                  class="h-6 w-full bg-transparent text-small text-ink outline-none placeholder:text-placeholder"
                />
              </ui-command-input>
            </div>
            <ui-command-list class="flex max-h-[240px] flex-col overflow-y-auto p-1">
              <Show when={direct()}>
                {(id) => (
                  <ui-command-item value={String(id())} label={`#${id()}`} class={POPUP_ITEM}>
                    <span class="font-mono text-mini text-ink-3">#{id()}</span>
                    <span class="truncate">
                      {LINK_LABEL[kind()]} #{id()}
                    </span>
                  </ui-command-item>
                )}
              </Show>
              <For each={direct() === undefined ? results() : []}>
                {(issue) => (
                  <ui-command-item value={String(issue.id)} label={issue.title} class={POPUP_ITEM}>
                    <span class="shrink-0 font-mono text-mini text-ink-3">#{issue.id}</span>
                    <span class="min-w-0 flex-1 truncate">{issue.title}</span>
                  </ui-command-item>
                )}
              </For>
              <Show when={direct() === undefined ? searchNote() : undefined}>
                {(note) => <span class="px-2 py-1.5 text-mini text-ink-3">{note()}</span>}
              </Show>
            </ui-command-list>
          </ui-command>
          <div class="px-2 pb-1.5">
            <FieldError message={props.error} />
          </div>
        </Show>
      </ui-popover-content>
    </ui-popover>
  )
}
