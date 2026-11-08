import { createSignal, Show, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { navigate } from "../../lib/router.ts"
import { slugify } from "../../lib/slug.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"

type CreatedProject = {
  readonly slug: string
  readonly coordinatorId: number | undefined
}

export function NewProjectDialog(props: { open: boolean; onClose: () => void }): JSX.Element {
  const [name, setName] = createSignal("")
  const [goal, setGoal] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [created, setCreated] = createSignal<CreatedProject>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  resetOnOpen(
    () => props.open,
    () => {
      setName("")
      setGoal("")
      setMessage("")
      setCreated(undefined)
      setFailure(undefined)
      setBusy(false)
    },
  )

  const ready = (): boolean => !busy() && slugify(name()) !== ""

  const create = async (): Promise<void> => {
    if (!ready()) return
    setBusy(true)
    setFailure(undefined)
    try {
      let project = created()
      if (project === undefined) {
        const result = await cmd<unknown>("project.create", {
          slug: slugify(name()),
          name: name().trim(),
          ...(goal().trim() === "" ? {} : { goal: goal().trim() }),
        })
        project = projectOf(result)
        if (project === undefined) throw new Error("The project was created without a slug.")
        setCreated(project)
      }
      const text = message().trim()
      if (text !== "") {
        if (project.coordinatorId === undefined) throw new Error("The project has no coordinator to message.")
        await cmd("message.send", { conv: project.coordinatorId, text })
      }
      props.onClose()
      navigate(`/p/${project.slug}`)
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
      title="New project"
      busy={busy()}
      onSubmit={() => void create()}
      footer={
        <>
          <span class="mr-auto text-[11.5px] text-fg-3">You can change all of this later in project settings</span>
          <button
            type="button"
            disabled={busy()}
            onClick={props.onClose}
            class="h-8 rounded-[2px] px-3 text-[12.5px] text-fg-2 hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready()}
            class="flex h-8 items-center gap-1.5 rounded-[2px] bg-accent px-3 text-[12.5px] font-medium text-ink disabled:opacity-40"
          >
            {busy() ? "Creating…" : "Create project"}
            <span class="kbd border-ink/30 text-ink">⌘↵</span>
          </button>
        </>
      }
    >
      <Field label="Name" hint="Shown in the sidebar and in push notifications">
        <input
          autofocus
          class={`${FIELD_INPUT} h-[34px]`}
          value={name()}
          maxlength={200}
          disabled={busy()}
          placeholder="Launch the new pricing page"
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </Field>

      <Field label="Goal" optional hint="The coordinator reads this on every turn.">
        <textarea
          class={`${FIELD_INPUT} min-h-[76px] resize-y py-2`}
          value={goal()}
          disabled={busy()}
          placeholder="What should this project get done?"
          onInput={(event) => setGoal(event.currentTarget.value)}
        />
      </Field>

      <Field label="First message" optional hint="Sent to the coordinator once the project is created.">
        <textarea
          class={`${FIELD_INPUT} min-h-[64px] resize-y py-2`}
          value={message()}
          disabled={busy()}
          placeholder="Start with the launch brief."
          onInput={(event) => setMessage(event.currentTarget.value)}
        />
      </Field>

      <Show when={failure()}>
        {(text) => <div class="text-[12px] text-bad">{text()}</div>}
      </Show>
    </Dialog>
  )
}

function projectOf(value: unknown): CreatedProject | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const slug = Reflect.get(value, "slug")
  if (typeof slug !== "string" || slug === "") return undefined
  const coordinatorId = Reflect.get(value, "coordinatorId")
  return { slug, coordinatorId: typeof coordinatorId === "number" ? coordinatorId : undefined }
}
