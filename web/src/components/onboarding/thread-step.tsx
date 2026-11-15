import { createEffect, createMemo, createSignal, For, Index, Match, Show, Switch, type JSX } from "solid-js"
import { ArrowUp, Check, Circle } from "lucide-solid"
import { IngleMark } from "./chrome.tsx"
import { QuietButton, StatusLine } from "./controls.tsx"
import { itemsOf, OwnerBubble, type EntryItem } from "../chat/entries.tsx"
import { Markdown } from "../chat/markdown.tsx"
import { connect } from "../../state/connection.ts"
import { createConversationView, liveOf, type BatchRow } from "../../state/conversation.ts"
import {
  markFirstReport,
  messageOf,
  onboardingCaptain,
  onboardingProvider,
  onboardingPush,
  onboardingReported,
  openNotifications,
  previousStep,
  sendFirstMessage,
} from "../../state/onboarding.ts"
import { sendKeyFor, type CaptainResult, type SendKey } from "../../lib/onboarding.ts"
import { navigate } from "../../lib/router.ts"

type SignalState = "working" | "done" | "failed" | "needs"

function Signal(props: { state: SignalState }): JSX.Element {
  return (
    <span class="sig" data-state={props.state} data-size="12" aria-hidden="true">
      <Index each={Array.from({ length: 9 })}>{() => <i />}</Index>
    </span>
  )
}

function EventLine(props: { state: SignalState; children: JSX.Element }): JSX.Element {
  return (
    <p
      class="im-event flex items-center justify-center gap-2 text-center text-sm"
      classList={{ "text-failed": props.state === "failed", "text-ink-3": props.state !== "failed" }}
    >
      <Signal state={props.state} />
      <span class="min-w-0 truncate">{props.children}</span>
    </p>
  )
}

const reportState = (row: BatchRow): SignalState => (row.status === "failed" || row.status === "cancelled" ? "failed" : "done")

function ReportCard(props: { row: BatchRow; first: boolean; captain: string }): JSX.Element {
  return (
    <article class="im-arrive rounded-md border border-line-1 bg-panel px-4 py-3.5">
      <header class="flex items-center gap-2 text-sm text-ink-3">
        <Show when={props.first}>
          <span class="inline-flex h-5 items-center gap-1 rounded-sm bg-done-soft px-1.5 text-done-text">
            <Check size={12} stroke-width={2} aria-hidden="true" />
            Your first report
          </span>
        </Show>
        <span>{props.captain}</span>
      </header>
      <h3 class="mt-2 text-base font-medium text-ink">{props.row.title === "" ? "Report" : props.row.title}</h3>
      <div class="mt-1 text-base text-ink-2">
        <Markdown muted text={props.row.text} />
      </div>
    </article>
  )
}

function Timeline(props: { items: readonly EntryItem[]; captain: CaptainResult; firstReport: BatchRow | undefined }): JSX.Element {
  const reported = createMemo(
    (): ReadonlySet<string> => new Set(props.items.flatMap((item) => (item.kind === "report" ? [item.row.title] : []))),
  )
  return (
    <For each={props.items}>
      {(item) => (
        <Switch>
          <Match when={item.kind === "owner" && item}>
            {(owner) => <OwnerBubble text={owner().text} attachments={owner().attachments} density="chat" />}
          </Match>
          <Match when={item.kind === "assistant" && item}>
            {(assistant) => (
              <div class="flex flex-col gap-3">
                <Show when={assistant().text !== ""}>
                  <Markdown text={assistant().text} />
                </Show>
                <For each={assistant().calls}>
                  {(call) => {
                    const title = call.arguments["title"]
                    const label = typeof title === "string" ? title : "A thread"
                    return <EventLine state={reported().has(label) ? "done" : "working"}>{label} started</EventLine>
                  }}
                </For>
              </div>
            )}
          </Match>
          <Match when={item.kind === "report" && item}>
            {(report) => (
              <div class="flex flex-col gap-3">
                <EventLine state={reportState(report().row)}>
                  {report().row.title} {reportState(report().row) === "failed" ? report().row.status : "finished"}
                </EventLine>
                <ReportCard row={report().row} first={report().row === props.firstReport} captain={props.captain.name} />
              </div>
            )}
          </Match>
          <Match when={item.kind === "question" && item}>
            {(question) => <EventLine state="needs">{question().row.title} needs you: {question().row.text}</EventLine>}
          </Match>
          <Match when={item.kind === "failure" && item}>
            {(failure) => <EventLine state="failed">{failure().failure.error}</EventLine>}
          </Match>
        </Switch>
      )}
    </For>
  )
}

function Checklist(): JSX.Element {
  const rows = (): readonly { label: string; done: boolean; onClick?: () => void }[] => [
    { label: "Sign in", done: true },
    { label: "Add a model key", done: onboardingProvider() !== undefined },
    { label: "Create your first Captain", done: onboardingCaptain() !== undefined },
    { label: "Get your first report", done: onboardingReported() },
    { label: "Turn on notifications", done: onboardingPush().kind === "on", onClick: () => openNotifications(true) },
  ]
  const count = (): number => rows().filter((row) => row.done).length

  return (
    <aside class="im-arrive w-full rounded-lg border border-line-1 bg-card p-2 lg:w-[260px] lg:shrink-0">
      <div class="flex h-8 items-center gap-1.5 rounded-sm bg-secondary px-2.5 text-base">
        <span class="font-medium text-ink">Checklist</span>
        <span class="text-ink-3 tabular-nums">
          {count()} of {rows().length}
        </span>
      </div>
      <ul class="mt-1 flex flex-col">
        <For each={rows()}>
          {(row) => (
            <li>
              <button
                type="button"
                disabled={row.onClick === undefined || row.done}
                onClick={() => row.onClick?.()}
                class="im-hover flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-base disabled:cursor-default disabled:hover:bg-transparent"
                classList={{ "text-ink-3": row.done, "text-ink": !row.done }}
              >
                <Show
                  when={row.done}
                  fallback={<Circle size={13} stroke-width={1.75} class="shrink-0 text-icon" aria-hidden="true" />}
                >
                  <Check size={14} stroke-width={2} class="im-arrive shrink-0 text-done" aria-hidden="true" />
                </Show>
                {row.label}
              </button>
            </li>
          )}
        </For>
      </ul>
      <p class="px-2.5 pb-1 pt-3 text-sm text-ink-3">The Captain keeps working after you leave this page.</p>
    </aside>
  )
}

export function ThreadStep(): JSX.Element {
  return (
    <Show
      when={onboardingCaptain()}
      fallback={
        <section class="im-arrive w-full max-w-[440px] rounded-lg border border-line-1 bg-card px-7 py-6">
          <p class="text-base text-ink-2">Create a Captain first, then send it the first thing to work on.</p>
          <div class="mt-4 flex items-center justify-between">
            <QuietButton label="Back" back onClick={previousStep} />
            <QuietButton label="Skip for now" onClick={() => navigate("/")} />
          </div>
        </section>
      }
    >
      {(captain) => <CaptainChat captain={captain()} />}
    </Show>
  )
}

function CaptainChat(props: { captain: CaptainResult }): JSX.Element {
  const snapshot = createConversationView(connect(), () => props.captain.coordinatorId)
  const [draft, setDraft] = createSignal("")
  const [pending, setPending] = createSignal<string | undefined>(undefined)
  const [sending, setSending] = createSignal(false)
  const [failure, setFailure] = createSignal<string | undefined>(undefined)
  let key: SendKey | undefined

  const items = createMemo((): readonly EntryItem[] => itemsOf(snapshot()?.entries ?? []))
  const live = () => liveOf(snapshot())
  const firstReport = createMemo((): BatchRow | undefined => {
    for (const item of items()) if (item.kind === "report" && reportState(item.row) === "done") return item.row
    return undefined
  })
  const started = (): boolean => items().length > 0 || pending() !== undefined
  const showPending = (): boolean => {
    const text = pending()
    return text !== undefined && !items().some((item) => item.kind === "owner" && item.text === text)
  }

  createEffect(() => {
    if (firstReport() !== undefined) markFirstReport()
  })

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === "" || sending()) return
    setSending(true)
    setFailure(undefined)
    setPending(trimmed)
    try {
      key = sendKeyFor(key, trimmed, () => ({ text: trimmed, id: crypto.randomUUID(), at: Date.now() }))
      await sendFirstMessage(props.captain, key)
      key = undefined
      setDraft("")
    } catch (error) {
      setPending(undefined)
      setFailure(messageOf(error, "The message did not reach the Captain."))
    } finally {
      setSending(false)
    }
  }

  const greeting = (): string =>
    props.captain.description === ""
      ? "Here are a few ways to start. You can also just tell me what you need."
      : `I’ve read the goal: ${props.captain.description} Here are a few ways to start. You can also just tell me what you need.`

  return (
    <div class="flex w-full max-w-[940px] flex-col items-start gap-4 lg:flex-row">
      <section class="im-arrive flex min-w-0 flex-1 flex-col rounded-lg border border-line-1 bg-card">
        <header class="flex h-11 items-center gap-2 border-b border-line-1 px-4">
          <span class="grid h-5 w-5 place-items-center rounded-sm bg-secondary text-ink">
            <IngleMark size={13} />
          </span>
          <span class="text-base font-medium">{props.captain.name}</span>
          <span class="ml-auto text-sm text-ink-3">Step 4 of 4</span>
        </header>

        <div class="flex flex-col gap-4 px-4 py-4">
          <div class="flex flex-col gap-1">
            <span class="text-sm text-ink-3">{props.captain.name} · just now</span>
            <p class="text-base text-ink">{greeting()}</p>
          </div>

          <Show when={!started()}>
            <div class="im-stagger grid grid-cols-1 gap-2 sm:grid-cols-2">
              <For each={props.captain.suggestions}>
                {(suggestion, index) => (
                  <button
                    type="button"
                    style={{ "--i": String(index()) }}
                    onClick={() => void send(suggestion.title)}
                    disabled={sending()}
                    class="im-press flex flex-col rounded-md bg-secondary px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover disabled:opacity-60"
                  >
                    <span class="text-base text-ink">{suggestion.title}</span>
                    <span class="text-sm text-ink-3">{suggestion.detail}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Timeline items={items()} captain={props.captain} firstReport={firstReport()} />

          <Show when={showPending()}>
            <div class="opacity-70">
              <OwnerBubble text={pending() ?? ""} density="chat" />
            </div>
          </Show>

          <Show when={live().busy}>
            <p class="im-event flex items-center gap-2 text-sm">
              <span class="im-shimmer">{props.captain.name} is working</span>
              <span class="im-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </p>
          </Show>

          <StatusLine tone="error" text={failure()} />
        </div>

        <form
          class="m-3 mt-auto flex items-end gap-2 rounded-lg border border-line-2 bg-panel p-2 pl-3 shadow-[var(--shadow-composer)]"
          onSubmit={(event) => {
            event.preventDefault()
            void send(draft())
          }}
        >
          <textarea
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                void send(draft())
              }
            }}
            rows={1}
            aria-label={`Message ${props.captain.name}`}
            placeholder={started() ? `Reply to ${props.captain.name}…` : `Message ${props.captain.name}…`}
            class="max-h-32 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-base text-ink [field-sizing:content] placeholder:text-placeholder focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={sending() || draft().trim() === ""}
            data-state={draft().trim() === "" ? "idle" : "ready"}
            class="im-send grid h-8 w-8 shrink-0 place-items-center rounded-md"
          >
            <ArrowUp size={16} stroke-width={2} aria-hidden="true" />
          </button>
        </form>
      </section>

      <div class="flex w-full flex-col gap-3 lg:w-[260px] lg:shrink-0">
        <Checklist />
        <div class="flex justify-end gap-2">
          <QuietButton label="Back" back onClick={previousStep} />
          <button
            type="button"
            onClick={() => navigate("/")}
            class="im-press h-8 rounded-md bg-secondary px-3 text-base text-ink transition-colors duration-150 hover:bg-hover"
          >
            Finish setup
          </button>
        </div>
      </div>
    </div>
  )
}
