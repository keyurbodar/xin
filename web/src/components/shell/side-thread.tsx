import { createSignal, Show, type JSX } from "solid-js"
import { sideThread } from "../../state/captains.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"

/** A side thread forks this conversation at its newest entry, runs the task with the whole context, and reports back here. */
export function SideThreadDialog(props: {
  open: boolean
  conv: number
  name: string
  onClose: () => void
  onCreated: (threadId: number) => void
}): JSX.Element {
  const [title, setTitle] = createSignal("")
  const [task, setTask] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  resetOnOpen(
    () => props.open,
    () => {
      setTitle("")
      setTask("")
      setFailure(undefined)
      setBusy(false)
    },
  )

  const ready = (): boolean => !busy() && title().trim() !== "" && task().trim() !== ""

  const create = async (): Promise<void> => {
    if (!ready()) return
    setBusy(true)
    setFailure(undefined)
    try {
      const threadId = await sideThread(props.conv, title().trim(), task().trim())
      props.onClose()
      props.onCreated(threadId)
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
      title={`Side thread from ${props.name}`}
      width="w-[var(--w-dialog)]"
      busy={busy()}
      onSubmit={() => void create()}
      footer={
        <>
          <Show when={failure()} fallback={<span class="mr-auto text-xs text-ink-3">It sees this chat so far and reports back to it</span>}>
            {(text) => <span class="mr-auto truncate text-xs text-failed">{text()}</span>}
          </Show>
          <button
            type="button"
            disabled={busy()}
            onClick={props.onClose}
            class="h-8 rounded-sm px-3 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready()}
            class="h-8 rounded-sm bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {busy() ? "Forking" : "Start side thread"}
          </button>
        </>
      }
    >
      <Field label="Title">
        <input
          class={`${FIELD_INPUT} h-8`}
          value={title()}
          maxLength={200}
          placeholder="Check the pricing numbers"
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
      </Field>
      <Field label="Task" hint="The brief it runs on top of everything said so far. ⌘↵ starts it.">
        <textarea
          class={`${FIELD_INPUT} min-h-[120px] resize-y py-2`}
          value={task()}
          placeholder="What should the side thread look into while this chat carries on?"
          onInput={(event) => setTask(event.currentTarget.value)}
        />
      </Field>
    </Dialog>
  )
}
