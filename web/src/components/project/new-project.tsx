import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { navigate } from "../../lib/router.ts"
import { slugify } from "../../lib/slug.ts"
import { createPresence } from "../shell/presence.ts"
import { Icon } from "../ui/icon.tsx"

type CreatedProject = {
  readonly slug: string
  readonly coordinatorId: number | undefined
}

export function NewProjectDialog(props: { open: boolean; onClose: () => void }): JSX.Element {
  const { mounted, leaving } = createPresence(() => props.open, 140)
  return (
    <Show when={mounted()}>
      <Dialog closing={leaving()} onClose={props.onClose} />
    </Show>
  )
}

function projectOf(value: unknown): CreatedProject | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const slug = Reflect.get(value, "slug")
  if (typeof slug !== "string" || slug === "") return undefined
  const coordinatorId = Reflect.get(value, "coordinatorId")
  return { slug, coordinatorId: typeof coordinatorId === "number" ? coordinatorId : undefined }
}

const INPUT =
  "w-full rounded-[2px] border border-line-inner bg-surface px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-4 focus:border-accent-line focus:ring-[3px] focus:ring-accent-dim disabled:opacity-50"

function Dialog(props: { closing: boolean; onClose: () => void }): JSX.Element {
  const [name, setName] = createSignal("")
  const [goal, setGoal] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [created, setCreated] = createSignal<CreatedProject>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  let panel!: HTMLFormElement
  let nameField!: HTMLInputElement

  const focusables = (): readonly HTMLElement[] => [
    ...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ]

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      if (!busy()) props.onClose()
      return
    }
    if (event.key !== "Tab") return
    const items = focusables()
    const first = items[0]
    const last = items[items.length - 1]
    if (first === undefined || last === undefined) return
    const active = document.activeElement
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault()
        last.focus()
      }
      return
    }
    if (active === last || !panel.contains(active)) {
      event.preventDefault()
      first.focus()
    }
  }

  onMount(() => {
    nameField.focus()
    document.addEventListener("keydown", onKey)
  })
  onCleanup(() => document.removeEventListener("keydown", onKey))

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

  const shortcut = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void create()
    }
  }

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 transition-opacity duration-[140ms]"
      classList={{ "opacity-0": props.closing }}
      onMouseDown={() => {
        if (!busy()) props.onClose()
      }}
    >
      <form
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        class="relative w-[640px] max-w-[calc(100vw-32px)] rounded-[4px] border border-line-inner bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.65)]"
        classList={{ enter: !props.closing, "dialog-out": props.closing }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
        onKeyDown={shortcut}
      >
        <div class="flex items-center border-b border-line px-5 py-3.5">
          <h2 id="new-project-title" class="text-[15px] font-medium">
            New project
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            disabled={busy()}
            class="ml-auto grid h-7 w-7 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div class="flex flex-col gap-4 px-5 py-4">
          <Field label="Name" hint="Shown in the sidebar and in push notifications">
            <input
              ref={nameField}
              class={`${INPUT} h-[34px]`}
              value={name()}
              maxlength={200}
              disabled={busy()}
              placeholder="Launch the new pricing page"
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </Field>

          <Field label="Goal" optional hint="The coordinator reads this on every turn.">
            <textarea
              class={`${INPUT} min-h-[76px] resize-y py-2`}
              value={goal()}
              disabled={busy()}
              placeholder="What should this project get done?"
              onInput={(event) => setGoal(event.currentTarget.value)}
            />
          </Field>

          <Field label="First message" optional hint="Sent to the coordinator once the project is created.">
            <textarea
              class={`${INPUT} min-h-[64px] resize-y py-2`}
              value={message()}
              disabled={busy()}
              placeholder="Start with the launch brief."
              onInput={(event) => setMessage(event.currentTarget.value)}
            />
          </Field>

          <Show when={failure() !== undefined}>
            <div class="text-[12px] text-bad">{failure()}</div>
          </Show>
        </div>

        <div class="flex items-center gap-2 border-t border-line px-5 py-3">
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
        </div>
      </form>
    </div>
  )
}

function Field(props: { label: string; optional?: boolean; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="flex items-baseline gap-1.5">
        <span class="text-[12px] font-medium text-fg-2">{props.label}</span>
        <Show when={props.optional === true}>
          <span class="text-[12px] text-fg-4">optional</span>
        </Show>
      </span>
      {props.children}
      <Show when={props.hint !== undefined}>
        <span class="text-[11.5px] text-fg-3">{props.hint}</span>
      </Show>
    </label>
  )
}
