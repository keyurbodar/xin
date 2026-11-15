import { createSignal, For, Show, type JSX } from "solid-js"
import { isDefinitive } from "../../lib/api.ts"
import {
  createArgs,
  draftOf,
  draftReady,
  newTrigger,
  parseAutomation,
  TARGET_WORD,
  updateArgs,
  type Automation,
  type AutomationDraft,
} from "../../lib/automations.ts"
import { createAutomation, updateAutomation } from "../../state/automations.ts"
import { activeProjects } from "../../state/home.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"
import { TriggersEditor } from "./triggers.tsx"

const TARGET_SHORT: Readonly<Record<Automation["target"], string>> = { fresh: "New thread", same: "Standing thread" }

const TARGETS: readonly Automation["target"][] = ["fresh", "same"]

const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * New and edit share one dialog. Create is idempotent per command id: a retry after a lost ack reuses it, and a
 * rejection mints a new one. Edit sends only the fields that changed (`updateArgs`).
 */
export function AutomationDialog(props: {
  open: boolean
  project?: string | undefined
  editing?: Automation | undefined
  onClose: () => void
  onSaved?: ((automation: Automation) => void) | undefined
}): JSX.Element {
  const empty = (): AutomationDraft => {
    if (props.editing !== undefined) return draftOf(props.editing)
    return {
      title: "",
      prompt: "",
      project: props.project ?? activeProjects()[0]?.id ?? "",
      target: "fresh",
      triggers: [newTrigger("schedule", "new-0", browserZone())],
    }
  }
  const [draft, setDraft] = createSignal<AutomationDraft>(empty())
  const [commandId, setCommandId] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const set = (patch: Partial<AutomationDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  resetOnOpen(
    () => props.open,
    () => {
      setDraft(empty())
      setCommandId(crypto.randomUUID())
      setFailure(undefined)
      setBusy(false)
    },
  )

  const patch = (): Record<string, unknown> | undefined => {
    const editing = props.editing
    return editing === undefined ? undefined : updateArgs(editing, draft())
  }
  const changed = (): boolean => {
    const update = patch()
    return update === undefined || Object.keys(update).length > 1
  }
  const ready = (): boolean => !busy() && draftReady(draft()) && changed()

  const submit = async (): Promise<void> => {
    if (!ready()) return
    setBusy(true)
    setFailure(undefined)
    try {
      const update = patch()
      const saved =
        update === undefined ? await createAutomation(createArgs(draft()), commandId()) : await updateAutomation(update)
      const automation = parseAutomation(saved)
      props.onClose()
      if (automation !== undefined) props.onSaved?.(automation)
    } catch (problem) {
      if (isDefinitive(problem)) setCommandId(crypto.randomUUID())
      setFailure(problem instanceof Error ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  const editing = (): boolean => props.editing !== undefined

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={editing() ? "Edit automation" : "New automation"}
      busy={busy()}
      width="w-[600px]"
      onSubmit={() => void submit()}
      footer={
        <>
          <span class="text-xs text-ink-3">Runs the prompt as you, in the project you pick.</span>
          <span class="mr-auto" />
          <button
            type="button"
            disabled={busy()}
            onClick={props.onClose}
            class="im-press h-8 rounded-sm px-3 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready()}
            class="im-press flex h-8 items-center gap-1.5 rounded-sm bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-40"
          >
            {busy() ? (editing() ? "Saving…" : "Creating…") : editing() ? "Save" : "Create"}
            <span class="kbd border-on-primary/30 text-on-primary">⌘↵</span>
          </button>
        </>
      }
    >
      <Field label="Title">
        <input
          autofocus
          class={`${FIELD_INPUT} h-[34px]`}
          value={draft().title}
          maxlength={120}
          disabled={busy()}
          placeholder="Weekly pipeline review"
          onInput={(event) => set({ title: event.currentTarget.value })}
        />
      </Field>
      <Field label="Prompt" hint="What the agent does each run, as if you typed it into the thread">
        <textarea
          class={`${FIELD_INPUT} min-h-[96px] resize-y py-2 leading-5`}
          value={draft().prompt}
          disabled={busy()}
          placeholder="Review the pipeline and list the deals that slipped this week."
          onInput={(event) => set({ prompt: event.currentTarget.value })}
        />
      </Field>
      <TriggersEditor triggers={draft().triggers} busy={busy()} tz={browserZone()} onChange={(triggers) => set({ triggers })} />
      <div class="grid grid-cols-2 gap-3">
        <Field label="Project">
          <select
            class={`${FIELD_INPUT} h-[34px]`}
            value={draft().project}
            disabled={busy()}
            onChange={(event) => set({ project: event.currentTarget.value })}
          >
            <Show when={activeProjects().length === 0}>
              <option value="">No projects yet</option>
            </Show>
            <For each={activeProjects()}>{(project) => <option value={project.id}>{project.name}</option>}</For>
          </select>
        </Field>
        <div class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-ink-2">Each run goes to</span>
          <div role="radiogroup" aria-label="Each run goes to" class="grid h-[34px] grid-cols-2 gap-0.5 rounded-sm border border-line-2 bg-panel p-0.5">
            <For each={TARGETS}>
              {(target) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft().target === target}
                  title={TARGET_WORD[target]}
                  disabled={busy()}
                  onClick={() => set({ target })}
                  class="im-press truncate rounded-xs px-1.5 text-xs text-ink-3 hover:text-ink aria-checked:bg-card aria-checked:text-ink aria-checked:shadow-ring"
                >
                  {TARGET_SHORT[target]}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
      <Show when={failure()}>{(text) => <div class="im-event text-sm text-failed">{text()}</div>}</Show>
    </Dialog>
  )
}
