import { createSignal, For, Show, type JSX } from "solid-js"
import { isDefinitive } from "../../lib/api.ts"
import { createArgs, cronInWords, cronProblem, draftReady, TARGET_WORD, type Automation, type AutomationDraft } from "../../lib/automations.ts"
import { createAutomation } from "../../state/automations.ts"
import { activeProjects } from "../../state/home.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"

const PRESETS: readonly { readonly label: string; readonly cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9:00", cron: "0 9 * * *" },
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Mondays 9:00", cron: "0 9 * * 1" },
]

const TARGET_SHORT: Readonly<Record<Automation["target"], string>> = { fresh: "New thread", same: "Standing thread" }

const TARGETS: readonly Automation["target"][] = ["fresh", "same"]

const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** automation.create is idempotent per command id: a retry after a lost ack reuses it, and a rejection mints a new one. */
export function AutomationDialog(props: { open: boolean; project?: string | undefined; onClose: () => void }): JSX.Element {
  const empty = (): AutomationDraft => ({
    title: "",
    prompt: "",
    cron: "",
    project: props.project ?? activeProjects()[0]?.id ?? "",
    target: "fresh",
  })
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

  const ready = (): boolean => !busy() && draftReady(draft(), browserZone())
  const problem = (): string | undefined => (draft().cron.trim() === "" ? undefined : cronProblem(draft().cron, browserZone()))
  const words = (): string | undefined => {
    const cron = draft().cron.trim()
    if (cron === "" || problem() !== undefined) return undefined
    const said = cronInWords(cron)
    return said === cron ? undefined : said
  }

  const submit = async (): Promise<void> => {
    if (!ready()) return
    setBusy(true)
    setFailure(undefined)
    try {
      await createAutomation(createArgs(draft(), browserZone()), commandId())
      props.onClose()
    } catch (problem) {
      if (isDefinitive(problem)) setCommandId(crypto.randomUUID())
      setFailure(problem instanceof Error ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="New automation"
      busy={busy()}
      width="w-[560px]"
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
            {busy() ? "Creating…" : "Create"}
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
      <div class="flex flex-col gap-1.5">
        <Field label="Schedule">
          <input
            class={`${FIELD_INPUT} h-[34px] font-mono text-sm`}
            value={draft().cron}
            disabled={busy()}
            placeholder="0 9 * * 1-5"
            spellcheck={false}
            aria-invalid={problem() !== undefined}
            onInput={(event) => set({ cron: event.currentTarget.value })}
          />
        </Field>
        <div class="flex flex-wrap items-center gap-1.5">
          <For each={PRESETS}>
            {(preset) => (
              <button
                type="button"
                disabled={busy()}
                aria-pressed={draft().cron.trim() === preset.cron}
                onClick={() => set({ cron: preset.cron })}
                class="im-press im-hover h-6 rounded-sm border border-line-2 px-2 text-xs text-ink-2 aria-pressed:border-line-3 aria-pressed:bg-secondary aria-pressed:text-ink"
              >
                {preset.label}
              </button>
            )}
          </For>
          <span class="ml-auto truncate text-xs text-ink-3">
            <Show when={problem()}>{(text) => <span class="text-failed">{text()}</span>}</Show>
            <Show when={problem() === undefined && words()} fallback={problem() === undefined ? <>5-field cron · {browserZone()}</> : null}>
              {(said) => (
                <>
                  <span class="text-ink-2">{said()}</span> · {browserZone()}
                </>
              )}
            </Show>
          </span>
        </div>
      </div>
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
