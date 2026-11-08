import { createSignal, For, Show, type JSX } from "solid-js"
import { ANSWER_CHIP } from "../ui/state.tsx"
import { ago } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { respondToQuestion, retryThread, type InboxQuestion } from "../../state/requests.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { StatusGlyph } from "../ui/status-glyph.tsx"
import { FIELD } from "../ui/field.ts"

function joined(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ")
}

function problemText(problem: unknown, fallback: string): string {
  return problem instanceof Error ? problem.message : fallback
}

export function QuestionRow(props: {
  question: InboxQuestion
  projectName: string | undefined
  threadTitle: string | undefined
  projectSlug: string | undefined
}): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  let field!: HTMLInputElement

  const choices = (): readonly string[] => props.question.options ?? []

  const answer = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === "" || busy()) return
    setBusy(true)
    setFailure(undefined)
    try {
      await respondToQuestion(props.question, trimmed)
    } catch (problem) {
      setFailure(problemText(problem, "That answer did not go through"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex gap-3 rounded-[12px] border border-waiting/40 bg-surface px-3.5 py-3.5 hover:bg-hover">
      <StatusGlyph state="waiting" size={16} class="mt-0.5 shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-3">
          <span class="min-w-0 flex-1 text-[13.5px] font-medium leading-relaxed">{props.question.question}</span>
          <span class="mono-meta shrink-0">{ago(props.question.askedAt)}</span>
        </div>
        <div class="mt-1 flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">
            {joined([props.projectName, props.threadTitle])}
          </span>
          <Show when={props.projectSlug}>
            {(slug) => (
              <button type="button" class="link shrink-0" onClick={() => navigate(`/p/${slug()}`)}>
                Open thread
              </button>
            )}
          </Show>
        </div>

        <Show when={choices().length > 0}>
          <div class="mt-2.5 flex flex-wrap gap-1.5">
            <For each={choices()}>
              {(option) => (
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void answer(option)}
                  class={ANSWER_CHIP}
                >
                  {option}
                </button>
              )}
            </For>
          </div>
        </Show>

        <form
          class="mt-2.5 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void answer(field.value)
          }}
        >
          <input
            ref={field}
            disabled={busy()}
            aria-label="Answer in your own words"
            placeholder="Or answer in your own words…"
            class={`${FIELD} min-w-0 flex-1`}
          />
          <button
            type="submit"
            disabled={busy()}
            class="h-8 shrink-0 rounded-[8px] border border-line-inner bg-fill px-2.5 text-[12.5px] text-fg-2 hover:bg-selected hover:text-fg disabled:opacity-50"
          >
            Answer
          </button>
        </form>

        <Show when={failure() !== undefined}>
          <p class="mt-1.5 text-[11.5px] text-bad">{failure()}</p>
        </Show>
      </div>
    </div>
  )
}

export function ThreadRow(props: {
  thread: ThreadSummary
  project: ProjectSummary
  state: "waiting" | "failed"
}): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const retry = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setFailure(undefined)
    try {
      await retryThread(props.thread.id)
    } catch (problem) {
      setFailure(problemText(problem, "That retry did not go through"))
    } finally {
      setBusy(false)
    }
  }

  const meta = (): string =>
    joined([
      props.project.name,
      props.thread.statusLine ?? (props.state === "failed" ? "Run failed" : "Waiting on you"),
    ])

  return (
    <div
      class="flex gap-3 rounded-[12px] border bg-surface px-3.5 py-3.5 hover:bg-hover"
      classList={{ "border-waiting/40": props.state === "waiting", "border-line": props.state !== "waiting" }}
    >
      <StatusGlyph state={props.state} size={16} class="mt-0.5 shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-3">
          <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium">{props.thread.title}</span>
          <span class="mono-meta shrink-0">{ago(props.thread.beatAt)}</span>
        </div>
        <div class="mt-1 truncate text-[12.5px] text-fg-3">{meta()}</div>

        <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => navigate(`/p/${props.project.slug}`)}
            class={ANSWER_CHIP}
          >
            Open thread
          </button>
          <Show when={props.state === "failed"}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void retry()}
              class={ANSWER_CHIP}
            >
              {busy() ? "Retrying…" : "Retry"}
            </button>
          </Show>
        </div>

        <Show when={failure() !== undefined}>
          <p class="mt-1.5 text-[11.5px] text-bad">{failure()}</p>
        </Show>
      </div>
    </div>
  )
}
