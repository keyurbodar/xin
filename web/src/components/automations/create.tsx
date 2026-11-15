import { createSignal, For, Show, type JSX } from "solid-js"
import { cmd, OpError } from "../../lib/api.ts"
import { activeProjects } from "../../state/home.ts"
import { Button } from "../ui/button.tsx"

type Target = "fresh" | "same"

/** Automations are normally created by the agent; this is the owner's way in when there is no conversation to ask in. */
export function CreateAutomation(props: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [cron, setCron] = createSignal("")
  const [project, setProject] = createSignal("")
  const [target, setTarget] = createSignal<Target>("fresh")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const chosenProject = (): string => project() || (activeProjects()[0]?.id ?? "")

  const reset = (): void => {
    setTitle("")
    setPrompt("")
    setCron("")
    setProject("")
    setTarget("fresh")
    setError(undefined)
  }

  const close = (): void => {
    reset()
    props.onClose()
  }

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await cmd("automation.create", {
        title: title(),
        prompt: prompt(),
        project: chosenProject(),
        target: { kind: target() },
        triggers: [{ kind: "schedule", cron: cron().trim(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }],
      })
      props.onCreated()
      close()
    } catch (problem) {
      setError(problem instanceof OpError ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  const ready = (): boolean =>
    title().trim() !== "" && prompt().trim() !== "" && cron().trim() !== "" && chosenProject() !== ""

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 grid place-items-center bg-bg/80 p-6" onMouseDown={close}>
        <form
          class="crosshair enter w-[520px] rounded-md border border-line-2 bg-panel"
          onMouseDown={(event) => event.stopPropagation()}
          onSubmit={(event) => void submit(event)}
        >
          <div class="border-b border-line-1 px-5 pb-4 pt-5">
            <div class="label">New automation</div>
            <h2 class="mt-2 text-xl font-light tracking-[-0.02em]">Run a task on a clock.</h2>
          </div>

          <div class="flex flex-col gap-4 px-5 py-4">
            <Field label="Title">
              <input class={INPUT} value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Weekly pipeline review" />
            </Field>
            <Field label="Prompt">
              <textarea
                class={`${INPUT} min-h-[72px] resize-y py-2`}
                value={prompt()}
                onInput={(event) => setPrompt(event.currentTarget.value)}
                placeholder="Review the pipeline and post the deals that slipped."
              />
            </Field>
            <Field label="Cron, in your time zone">
              <input class={INPUT} value={cron()} onInput={(event) => setCron(event.currentTarget.value)} placeholder="0 16 * * 5" />
            </Field>
            <Field label="Project">
              <select class={INPUT} value={chosenProject()} onChange={(event) => setProject(event.currentTarget.value)}>
                <For each={activeProjects()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
              </select>
            </Field>
            <Field label="Target">
              <select class={INPUT} value={target()} onChange={(event) => setTarget(event.currentTarget.value === "same" ? "same" : "fresh")}>
                <option value="fresh">A new thread each run</option>
                <option value="same">One standing thread</option>
              </select>
            </Field>
            <Show when={error() !== undefined}>
              <div class="text-sm text-failed">{error()}</div>
            </Show>
          </div>

          <div class="flex items-center justify-end gap-2 border-t border-line-1 px-5 py-3">
            <Button size="sm" variant="quiet" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={!ready() || busy()}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </Show>
  )
}

const INPUT =
  "h-8 w-full rounded-sm border border-line-2 bg-card px-2.5 text-sm outline-none placeholder:text-icon focus:border-line-3"

function Field(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="label">{props.label}</span>
      {props.children}
    </label>
  )
}
