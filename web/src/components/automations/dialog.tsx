import "@ui-sdk/web/segmented-control"
import "@ui-sdk/web/select"
import { Check, ChevronDown } from "lucide-solid"
import { createSignal, For, Show, type JSX } from "solid-js"
import { isDefinitive } from "../../lib/api.ts"
import {
  attemptFor,
  createArgs,
  draftOf,
  draftReady,
  newTrigger,
  parseAutomation,
  TARGET_WORD,
  updateArgs,
  type Attempt,
  type Automation,
  type AutomationDraft,
} from "../../lib/automations.ts"
import { createAutomation, updateAutomation } from "../../state/automations.ts"
import { activeProjects } from "../../state/home.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"
import { POPUP, POPUP_ITEM } from "../ui/surface.ts"
import { TriggersEditor } from "./triggers.tsx"

const TARGET_SHORT: Readonly<Record<Automation["target"], string>> = { fresh: "New thread", same: "Standing thread" }

const TARGETS: readonly Automation["target"][] = ["fresh", "same"]

const targetOf = (value: unknown): Automation["target"] | undefined => TARGETS.find((target) => target === value)

const LABEL = "text-sm font-title text-ink-2"

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
  const [attempt, setAttempt] = createSignal<Attempt>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const set = (patch: Partial<AutomationDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  resetOnOpen(
    () => props.open,
    () => {
      setDraft(empty())
      setAttempt(undefined)
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
  const ready = (): boolean => !busy() && draftReady(draft(), props.editing) && changed()

  const submit = async (): Promise<void> => {
    if (!ready()) return
    setBusy(true)
    setFailure(undefined)
    try {
      const update = patch()
      const args = update ?? createArgs(draft())
      const sent = attemptFor(attempt(), args, () => crypto.randomUUID())
      setAttempt(sent)
      const saved = update === undefined ? await createAutomation(args, sent.id) : await updateAutomation(args, sent.id)
      const automation = parseAutomation(saved)
      props.onClose()
      if (automation !== undefined) props.onSaved?.(automation)
    } catch (problem) {
      if (isDefinitive(problem)) setAttempt(undefined)
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
            class="im-press flex h-8 items-center gap-1.5 rounded-sm bg-primary px-3 text-sm font-title text-on-primary disabled:opacity-40"
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
        <ui-select
          class="flex min-w-0 flex-col gap-1.5"
          prop:value={draft().project === "" ? null : draft().project}
          placeholder="No projects yet"
          disabled={busy() || activeProjects().length === 0 ? "" : undefined}
          on:valuechange={(event) => {
            const value = event.detail.value
            if (typeof value === "string") set({ project: value })
          }}
        >
          <ui-select-label class={LABEL}>Project</ui-select-label>
          <ui-select-trigger class="block">
            <button type="button" class={`${FIELD_INPUT} flex h-[34px] items-center gap-2 text-left`}>
              <ui-select-value class="min-w-0 flex-1 truncate data-[placeholder]:text-icon" />
              <ChevronDown size={14} stroke-width={1.5} class="shrink-0 text-icon" />
            </button>
          </ui-select-trigger>
          <ui-select-content side-offset="4" class={`${POPUP} w-[var(--anchor-width)]`}>
            <For each={activeProjects()}>
              {(project) => (
                <ui-select-item value={project.id} label={project.name} class={POPUP_ITEM}>
                  <ui-select-item-text class="min-w-0 flex-1 truncate">{project.name}</ui-select-item-text>
                  <ui-select-item-indicator class="text-ink-2">
                    <Check size={14} stroke-width={1.5} />
                  </ui-select-item-indicator>
                </ui-select-item>
              )}
            </For>
          </ui-select-content>
        </ui-select>
        <div class="flex flex-col gap-1.5">
          <span id="automation-target" class={LABEL}>
            Each run goes to
          </span>
          <ui-segmented-control
            aria-labelledby="automation-target"
            prop:value={draft().target}
            disabled={busy() ? "" : undefined}
            on:valuechange={(event) => {
              const target = targetOf(event.detail.value)
              if (target !== undefined) set({ target })
            }}
            class="grid h-[34px] grid-cols-2 gap-0.5 rounded-sm border border-line-2 bg-panel p-0.5"
          >
            <For each={TARGETS}>
              {(target) => (
                <ui-segmented-control-item
                  value={target}
                  title={TARGET_WORD[target]}
                  class="im-press grid cursor-default place-items-center truncate rounded-xs px-1.5 text-xs text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-primary-soft data-[checked]:bg-card data-[checked]:text-ink data-[checked]:shadow-ring data-[disabled]:opacity-50"
                >
                  {TARGET_SHORT[target]}
                </ui-segmented-control-item>
              )}
            </For>
          </ui-segmented-control>
        </div>
      </div>
      <Show when={failure()}>{(text) => <div class="im-event text-sm text-failed">{text()}</div>}</Show>
    </Dialog>
  )
}
