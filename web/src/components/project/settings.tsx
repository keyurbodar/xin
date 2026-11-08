import { createSignal, Show, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import type { ProjectSummary } from "../../state/home.ts"
import { Dialog, Field, resetOnOpen } from "../ui/dialog.tsx"
import { FIELD, FIELD_AREA } from "../ui/field.ts"

/** The settings the New project dialog promises: the same name and goal, and archiving the project. */
export function ProjectSettings(props: {
  project: ProjectSummary
  open: boolean
  onClose: () => void
  onArchived: () => void
}): JSX.Element {
  return (
    <Show when={props.project.id} keyed>
      {(_id: string) => <Body {...props} />}
    </Show>
  )
}

function Body(props: {
  project: ProjectSummary
  open: boolean
  onClose: () => void
  onArchived: () => void
}): JSX.Element {
  const [name, setName] = createSignal(props.project.name)
  const [goal, setGoal] = createSignal(props.project.goal ?? "")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [confirming, setConfirming] = createSignal(false)

  resetOnOpen(
    () => props.open,
    () => {
      setName(props.project.name)
      setGoal(props.project.goal ?? "")
      setFailure(undefined)
      setConfirming(false)
      setBusy(false)
    },
  )

  const dirty = (): boolean => name().trim() !== props.project.name || goal().trim() !== (props.project.goal ?? "")

  const save = async (): Promise<void> => {
    if (busy() || name().trim() === "") return
    setBusy(true)
    setFailure(undefined)
    try {
      await cmd("project.update", { id: props.project.id, name: name().trim(), goal: goal().trim() })
      props.onClose()
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  const archive = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      await cmd("project.archive", { id: props.project.id })
      props.onClose()
      props.onArchived()
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Project settings"
      busy={busy()}
      width="w-[560px]"
      onSubmit={() => void save()}
      footer={
        <>
          <Show
            when={confirming()}
            fallback={
              <button
                type="button"
                disabled={busy()}
                onClick={() => setConfirming(true)}
                class="h-8 rounded-[8px] px-2 text-[13px] text-fg-3 hover:text-bad disabled:opacity-50"
              >
                Archive project
              </button>
            }
          >
            <span class="text-[12.5px] text-fg-3">Archive {props.project.name}?</span>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void archive()}
              class="h-8 rounded-[8px] bg-bad-bg px-3 text-[13px] font-medium text-bad hover:bg-bad/[0.18] disabled:opacity-50"
            >
              Archive
            </button>
            <button
              type="button"
              disabled={busy()}
              onClick={() => setConfirming(false)}
              class="h-8 rounded-[8px] px-2 text-[13px] text-fg-2 hover:text-fg disabled:opacity-50"
            >
              Keep
            </button>
          </Show>
          <span class="mr-auto" />
          <Show when={!confirming()}>
            <button
              type="button"
              disabled={busy()}
              onClick={props.onClose}
              class="h-8 rounded-[8px] px-3 text-[13px] text-fg-2 hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy() || !dirty() || name().trim() === ""}
              class="h-8 rounded-[8px] bg-accent px-3 text-[13px] font-medium text-ink disabled:opacity-40"
            >
              {busy() ? "Saving…" : "Save"}
            </button>
          </Show>
        </>
      }
    >
      <Field label="Name" hint="Shown in the sidebar and in push notifications">
        <input
          autofocus
          class={FIELD}
          value={name()}
          maxlength={200}
          disabled={busy()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </Field>

      <Field label="Goal" optional hint="The coordinator reads this on every turn.">
        <textarea
          class={`${FIELD_AREA} min-h-[76px] resize-none`}
          value={goal()}
          disabled={busy()}
          placeholder="What should this project get done?"
          onInput={(event) => setGoal(event.currentTarget.value)}
        />
      </Field>

      <Show when={failure()}>
        {(text) => <div class="text-[12.5px] text-bad">{text()}</div>}
      </Show>
    </Dialog>
  )
}
