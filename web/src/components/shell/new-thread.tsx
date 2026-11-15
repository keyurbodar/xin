import { createSignal, Show, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { navigate } from "../../lib/router.ts"
import { numOf, recordOf } from "../../lib/parse.ts"
import { routeProject } from "../../state/home.ts"
import { openThreadTab } from "../../state/tabs.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"

const [open, setOpen] = createSignal(false)

export function openNewThread(): void {
  setOpen(true)
}

/** thread.create starts a thread under the project's coordinator, with the coordinator's model. */
export function NewThreadDialog(): JSX.Element {
  const [title, setTitle] = createSignal("")
  const [task, setTask] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const close = (): void => {
    setOpen(false)
  }

  resetOnOpen(open, () => {
    setTitle("")
    setTask("")
    setFailure(undefined)
    setBusy(false)
  })

  const ready = (): boolean => !busy() && routeProject() !== undefined && title().trim() !== "" && task().trim() !== ""

  const create = async (): Promise<void> => {
    const project = routeProject()
    if (!ready() || project === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = recordOf(
        await cmd<unknown>("thread.create", { project: project.slug, title: title().trim(), task: task().trim() }),
      )
      const threadId = numOf(result?.threadId)
      if (threadId === undefined) throw new Error("The thread was created without an id.")
      openThreadTab(project.id, threadId)
      close()
      navigate(`/p/${project.slug}/t/${threadId}`)
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open()}
      onClose={close}
      title={`New thread in ${routeProject()?.name ?? "this project"}`}
      width="w-[var(--w-dialog)]"
      busy={busy()}
      onSubmit={() => void create()}
      footer={
        <>
          <Show when={failure()} fallback={<span class="mr-auto text-xs text-ink-3">It runs on the coordinator's model</span>}>
            {(text) => <span class="mr-auto truncate text-xs text-failed">{text()}</span>}
          </Show>
          <button
            type="button"
            disabled={busy()}
            onClick={close}
            class="h-8 rounded-sm px-3 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready()}
            class="h-8 rounded-sm bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {busy() ? "Starting" : "Start thread"}
          </button>
        </>
      }
    >
      <Field label="Title">
        <input
          class={`${FIELD_INPUT} h-8`}
          value={title()}
          maxLength={200}
          placeholder="Rename the settings page"
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
      </Field>
      <Field label="Task" hint="The brief the thread starts from. ⌘↵ starts it.">
        <textarea
          class={`${FIELD_INPUT} min-h-[120px] resize-y py-2`}
          value={task()}
          placeholder="What should this thread do, and how will you know it is done?"
          onInput={(event) => setTask(event.currentTarget.value)}
        />
      </Field>
    </Dialog>
  )
}
