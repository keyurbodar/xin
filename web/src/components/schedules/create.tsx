import { createSignal, Show, type JSX } from "solid-js"
import { cmd, OpError } from "../../lib/api.ts"

type Target = "this_session" | "new_once" | "new"

/** Schedules are normally created by the agent; this is the owner's way in when there is no conversation to ask in. */
export function CreateSchedule(props: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [rule, setRule] = createSignal("")
  const [at, setAt] = createSignal("")
  const [target, setTarget] = createSignal<Target>("this_session")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const reset = (): void => {
    setTitle("")
    setPrompt("")
    setRule("")
    setAt("")
    setTarget("this_session")
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
    const once = at() === "" ? undefined : Date.parse(at())
    try {
      await cmd("schedule.create", {
        title: title(),
        prompt: prompt(),
        target: target(),
        ...(rule() === "" ? {} : { rrule: rule() }),
        ...(once === undefined ? {} : { at: once }),
      })
      props.onCreated()
      close()
    } catch (problem) {
      setError(problem instanceof OpError ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  const ready = (): boolean => title().trim() !== "" && prompt().trim() !== "" && (rule() !== "" || at() !== "")

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 grid place-items-center bg-page/80 p-6" onMouseDown={close}>
        <form
          class="crosshair enter w-[520px] rounded-[4px] border border-line-inner bg-surface"
          onMouseDown={(event) => event.stopPropagation()}
          onSubmit={(event) => void submit(event)}
        >
          <div class="border-b border-line px-5 pb-4 pt-5">
            <div class="label">New schedule</div>
            <h2 class="mt-2 text-[20px] font-light tracking-[-0.02em]">Run a task on a clock.</h2>
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
            <div class="grid grid-cols-2 gap-3">
              <Field label="Repeat (RRULE)">
                <input
                  class={INPUT}
                  value={rule()}
                  onInput={(event) => setRule(event.currentTarget.value)}
                  placeholder="FREQ=WEEKLY;BYDAY=MO"
                />
              </Field>
              <Field label="Or once at">
                <input class={INPUT} type="datetime-local" value={at()} onInput={(event) => setAt(event.currentTarget.value)} />
              </Field>
            </div>
            <Field label="Target">
              <select class={INPUT} value={target()} onChange={(event) => setTarget(event.currentTarget.value as Target)}>
                <option value="this_session">This session</option>
                <option value="new_once">A new thread, once</option>
                <option value="new">A new thread each time</option>
              </select>
            </Field>
            <Show when={error() !== undefined}>
              <div class="text-[12px] text-bad">{error()}</div>
            </Show>
          </div>

          <div class="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button type="button" class="h-7 rounded-[2px] px-3 text-[12.5px] text-fg-2 hover:text-fg" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!ready() || busy()}
              class="h-7 rounded-[2px] bg-accent px-3 text-[12.5px] font-medium text-[#160700] disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </Show>
  )
}

const INPUT =
  "h-8 w-full rounded-[2px] border border-line-inner bg-raised px-2.5 text-[12.5px] outline-none placeholder:text-fg-4 focus:border-line-strong"

function Field(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="label">{props.label}</span>
      {props.children}
    </label>
  )
}
