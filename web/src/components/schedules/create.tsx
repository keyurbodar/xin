import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { cmd, OpError } from "../../lib/api.ts"
import { describeRule } from "../../lib/format.ts"
import { Icon } from "../ui/icon.tsx"
import { Button } from "../ui/button.tsx"

type Target = "this_session" | "new_once" | "new"

type Parsed = { readonly rrule?: string; readonly at?: string; readonly next: readonly string[] }

/** Schedules are normally created by the agent; this is the owner's way in when there is no conversation to ask in. */
export function CreateSchedule(props: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [when, setWhen] = createSignal("")
  const [parsed, setParsed] = createSignal<Parsed>()
  const [parseError, setParseError] = createSignal<string>()
  const [target, setTarget] = createSignal<Target>("this_session")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const text = when().trim()
    clearTimeout(timer)
    setParsed(undefined)
    setParseError(undefined)
    if (text === "") return
    timer = setTimeout(() => {
      void cmd<Parsed>("schedule.parse", { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
        .then((value) => {
          if (when().trim() === text) setParsed(value)
        })
        .catch((problem: unknown) => {
          if (when().trim() === text) setParseError(problem instanceof OpError ? problem.message : "That time is unclear")
        })
    }, 300)
  })
  onCleanup(() => clearTimeout(timer))

  const reset = (): void => {
    setTitle("")
    setPrompt("")
    setWhen("")
    setParsed(undefined)
    setParseError(undefined)
    setTarget("this_session")
    setError(undefined)
  }

  const close = (): void => {
    reset()
    props.onClose()
  }

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const schedule = parsed()
    if (schedule === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await cmd("schedule.create", {
        title: title(),
        prompt: prompt(),
        target: target(),
        ...(schedule.rrule === undefined ? {} : { rrule: schedule.rrule }),
        ...(schedule.at === undefined ? {} : { at: Date.parse(schedule.at) }),
      })
      props.onCreated()
      close()
    } catch (problem) {
      setError(problem instanceof OpError ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  const ready = (): boolean => title().trim() !== "" && prompt().trim() !== "" && parsed() !== undefined

  const summary = (schedule: Parsed): string => {
    if (schedule.rrule !== undefined) return describeRule(schedule.rrule)
    return schedule.at === undefined ? "once" : new Date(schedule.at).toLocaleString()
  }

  const preview = (schedule: Parsed): string =>
    schedule.next.length === 0
      ? "no future run"
      : `next ${schedule.next.map((slot) => new Date(slot).toLocaleDateString(undefined, { day: "numeric", month: "short" })).join(", ")}`

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
            <Field label="When">
              <input
                class={INPUT}
                value={when()}
                onInput={(event) => setWhen(event.currentTarget.value)}
                placeholder="every friday at 4pm"
              />
            </Field>
            <Show when={parsed()}>
              {(schedule) => (
                <div class="flex items-center gap-1.5 font-mono text-[11px] text-fg-3">
                  <Icon name="check" size={12} class="text-ok" />
                  <span>{summary(schedule())}</span>
                  <span class="text-fg-4">·</span>
                  <span>{preview(schedule())}</span>
                </div>
              )}
            </Show>
            <Show when={parseError()}>
              {(message) => <div class="font-mono text-[11px] text-fg-4">{message()}</div>}
            </Show>
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
  "h-8 w-full rounded-[2px] border border-line-inner bg-raised px-2.5 text-[12.5px] outline-none placeholder:text-fg-4 focus:border-line-strong"

function Field(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="label">{props.label}</span>
      {props.children}
    </label>
  )
}
