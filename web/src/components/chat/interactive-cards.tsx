import { createEffect, createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { navigate } from "../../lib/router.ts"
import type { GatedCall, RequestRow } from "../../state/conversation.ts"
import { openRequests, provideSecret, respondToQuestion, settledRequests } from "../../state/requests.ts"
import { Icon, type IconName } from "../ui/icon.tsx"
import { Spinner } from "../ui/loaders.tsx"
import { Button } from "../ui/button.tsx"
import type { BlockPayloads } from "./registry.ts"

type Call = BlockPayloads["tool"]

/** Where a card stands: its tool still running, open for the owner, closed with an answer, or failed. */
export type CardState =
  | { readonly kind: "asking" }
  | { readonly kind: "open"; readonly request: RequestRow }
  | { readonly kind: "answered"; readonly answer: string }
  | { readonly kind: "declined" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly message: string }

const DECLINED = "declined"

/**
 * The one approval kind: an agent's request_approval (options Approve and Deny) and a call the tool policy holds
 * back (Approve, Always allow and Deny, with a requestId under POLICY_PREFIX). Either is answered with an option.
 */
export const APPROVAL_KIND = "approval"
const POLICY_PREFIX = "approval:"
const DENY = "Deny"
const PREVIEW_CHARS = 500

/** At most PREVIEW_CHARS code points, so a cut never splits a surrogate pair, with an ellipsis when it cuts. */
function preview(text: string): string {
  const points = Array.from(text)
  return points.length <= PREVIEW_CHARS ? text : `${points.slice(0, PREVIEW_CHARS - 1).join("")}…`
}

const text = (args: Record<string, unknown>, key: string): string => {
  const value = args[key]
  return typeof value === "string" ? value : ""
}

const strings = (args: Record<string, unknown>, key: string): readonly string[] => {
  const value = args[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function requestIdOf(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined
  const id: unknown = Reflect.get(details, "requestId")
  return typeof id === "string" ? id : undefined
}

export function cardState(call: Call): CardState {
  if (call.status === "error") return { kind: "failed", message: call.output ?? "The card could not open." }
  if (call.status !== "done") return { kind: "asking" }
  const id = requestIdOf(call.details)
  return id === undefined ? { kind: "closed" } : requestState(id)
}

/** Open while `request.list` lists the request, then its kept answer; an approval declines with Deny. */
function requestState(id: string): CardState {
  const request = openRequests().find((row) => row.id === id)
  if (request !== undefined) return { kind: "open", request }
  const settled = settledRequests().find((row) => row.id === id)
  if (settled === undefined) return { kind: "closed" }
  const declined = settled.answer === (settled.kind === APPROVAL_KIND ? DENY : DECLINED)
  return declined ? { kind: "declined" } : { kind: "answered", answer: settled.answer }
}

const STATUS: { readonly [K in CardState["kind"]]: string } = {
  asking: "Opening",
  open: "Waiting for you",
  answered: "Answered",
  declined: "Declined",
  closed: "Closed",
  failed: "Could not open",
}

/** The frame every card shares: an icon, a title, where it stands, and its body. */
function CardFrame(props: {
  icon: IconName
  title: string
  state: CardState
  label: string
  children: JSX.Element
}): JSX.Element {
  const open = (): boolean => props.state.kind === "open"
  return (
    <section
      aria-label={props.label}
      data-card={props.state.kind}
      class="overflow-hidden rounded-md border bg-card"
      classList={{ "border-primary/40": open(), "border-line-2": !open() }}
    >
      <header class="flex items-center gap-2.5 border-b border-line-1 px-3 py-2">
        <span
          class="grid h-6 w-6 shrink-0 place-items-center rounded-sm"
          classList={{ "bg-primary-soft text-primary-ink": open(), "bg-secondary text-ink-3": !open() }}
        >
          <Icon name={props.icon} size={14} />
        </span>
        <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{props.title}</span>
        <span
          class="mono-meta shrink-0"
          classList={{
            "text-primary-ink": open(),
            "text-done-text": props.state.kind === "answered",
            "text-failed": props.state.kind === "failed",
          }}
        >
          {STATUS[props.state.kind]}
        </span>
      </header>
      <div class="flex flex-col gap-2.5 px-3 py-3">{props.children}</div>
    </section>
  )
}

const answerOf = (state: CardState): string | undefined => (state.kind === "answered" ? state.answer : undefined)
const failureOf = (state: CardState): string | undefined => (state.kind === "failed" ? state.message : undefined)

/** The closed line under a card: what the owner answered, or that they declined. */
function Outcome(props: { state: CardState; answered: (answer: string) => string }): JSX.Element {
  return (
    <Switch>
      <Match when={answerOf(props.state)}>
        {(answer) => (
          <div class="flex items-center gap-2 text-base text-ink" data-outcome="answered">
            <Icon name="check" size={14} class="shrink-0 text-done" />
            <span class="min-w-0 [overflow-wrap:anywhere]">{props.answered(answer())}</span>
          </div>
        )}
      </Match>
      <Match when={props.state.kind === "declined"}>
        <div class="flex items-center gap-2 text-base text-ink-2" data-outcome="declined">
          <Icon name="x" size={14} class="shrink-0 text-ink-3" />
          <span>Declined</span>
        </div>
      </Match>
      <Match when={props.state.kind === "closed"}>
        <div class="text-sm text-ink-3">No longer waiting for an answer.</div>
      </Match>
      <Match when={failureOf(props.state)}>
        {(message) => <div class="text-sm text-failed">{message()}</div>}
      </Match>
    </Switch>
  )
}

/** Sends one answer at a time and keeps its failure on the card. */
function createSender(): {
  readonly sending: () => boolean
  readonly error: () => string | undefined
  readonly send: (run: () => Promise<void>) => Promise<boolean>
} {
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const send = async (run: () => Promise<void>): Promise<boolean> => {
    if (sending()) return false
    setSending(true)
    setError(undefined)
    try {
      await run()
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      setSending(false)
    }
  }
  return { sending, error, send }
}

function SendLine(props: { sending: boolean; error: string | undefined }): JSX.Element {
  return (
    <>
      <Show when={props.sending}>
        <div class="flex items-center gap-2 text-sm text-ink-3" role="status">
          <Spinner size={12} />
          Sending…
        </div>
      </Show>
      <Show when={props.error}>
        <div class="text-sm text-failed" role="alert">
          {props.error}
        </div>
      </Show>
    </>
  )
}

function openOf(state: CardState): RequestRow | undefined {
  return state.kind === "open" ? state.request : undefined
}

const FIELD =
  "im-focus h-9 min-w-0 flex-1 rounded-sm border border-line-2 bg-panel px-3 text-base text-ink outline-none placeholder:text-icon focus:border-line-3 disabled:opacity-60"

export function AskCard(call: Call): JSX.Element {
  const state = (): CardState => cardState(call)
  const sender = createSender()
  const [draft, setDraft] = createSignal("")
  const answer = (request: RequestRow, value: string): void => {
    const reply = value.trim()
    if (reply === "") return
    void sender.send(() => respondToQuestion(request, reply)).then((sent) => sent && setDraft(""))
  }
  return (
    <CardFrame icon="message" title="Question" label="Question for you" state={state()}>
      <p class="text-base leading-[1.6] text-ink">{text(call.args, "question")}</p>
      <Show when={openOf(state())} fallback={<Outcome state={state()} answered={(reply) => reply} />}>
        {(request) => (
          <>
            <Show when={strings(call.args, "options").length > 0}>
              <div class="flex flex-wrap gap-2" role="group" aria-label="Options">
                <For each={strings(call.args, "options")}>
                  {(option) => (
                    <Button
                      size="sm"
                      class="im-focus im-press"
                      disabled={sender.sending()}
                      onClick={() => answer(request(), option)}
                    >
                      {option}
                    </Button>
                  )}
                </For>
              </div>
            </Show>
            <form
              class="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                answer(request(), draft())
              }}
            >
              <input
                aria-label="Your answer"
                value={draft()}
                disabled={sender.sending()}
                onInput={(event) => setDraft(event.currentTarget.value)}
                placeholder="Answer in your own words"
                class={FIELD}
              />
              <Button type="submit" size="sm" variant="primary" class="im-focus" disabled={sender.sending() || draft().trim() === ""}>
                Send
              </Button>
            </form>
            <SendLine sending={sender.sending()} error={sender.error()} />
          </>
        )}
      </Show>
    </CardFrame>
  )
}

/** The one approval card: an action, optionally the held-back call, and a button per option the request carries. */
function Approval(props: {
  state: CardState
  action: string
  detail?: string | undefined
  call?: GatedCall | undefined
}): JSX.Element {
  const sender = createSender()
  return (
    <CardFrame icon="check" title="Approval" label="Approval request" state={props.state}>
      <p class="text-base font-medium leading-[1.5] text-ink">{props.action}</p>
      <Show when={props.detail}>
        {(detail) => <p class="whitespace-pre-wrap text-sm leading-[1.6] text-ink-2">{detail()}</p>}
      </Show>
      <Show when={props.call}>
        {(call) => (
          <div class="flex flex-col overflow-hidden rounded-sm border border-line-1 bg-panel" data-call={call().tool}>
            <span class="border-b border-line-1 px-2.5 py-1.5 font-mono text-sm text-ink">{call().tool}</span>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-xs leading-[1.6] text-ink-2 [overflow-wrap:anywhere]">
              {preview(call().arguments)}
            </pre>
          </div>
        )}
      </Show>
      <Show when={openOf(props.state)} fallback={<Outcome state={props.state} answered={(answer) => answer} />}>
        {(request) => (
          <>
            <div class="flex flex-wrap gap-2" role="group" aria-label="Decision">
              <For each={request().options}>
                {(option, index) => (
                  <Button
                    size="sm"
                    variant={index() === 0 ? "primary" : "ghost"}
                    class="im-focus im-press"
                    disabled={sender.sending()}
                    onClick={() => void sender.send(() => respondToQuestion(request(), option))}
                  >
                    {option}
                  </Button>
                )}
              </For>
            </div>
            <SendLine sending={sender.sending()} error={sender.error()} />
          </>
        )}
      </Show>
    </CardFrame>
  )
}

/** An agent's own ask, shown as prose from its tool block's args rather than as a held-back call. */
export function ApprovalCard(call: Call): JSX.Element {
  return (
    <Approval
      state={cardState(call)}
      action={text(call.args, "action")}
      detail={text(call.args, "detail") || undefined}
    />
  )
}

/** A policy approval: the held-back call with its arguments. */
export function PolicyApprovalCard(props: { request: RequestRow }): JSX.Element {
  return (
    <Approval state={requestState(props.request.id)} action={props.request.question} call={props.request.call} />
  )
}

/**
 * The policy approvals open on one conversation, for the views that show no tool block for them: a thread, a
 * coordinator or a root chat. An agent's own ask is left to its tool block. A card stays after it is answered,
 * showing the answer, until the view changes.
 */
export function PolicyApprovals(props: { conversationId: number }): JSX.Element {
  const open = createMemo(() =>
    openRequests().filter((row) => row.kind === APPROVAL_KIND && row.id.startsWith(POLICY_PREFIX) && row.conversationId === props.conversationId),
  )
  const [kept, setKept] = createSignal<ReadonlyMap<string, RequestRow>>(new Map())
  createEffect(() => {
    const now = open()
    if (now.length > 0) setKept((current) => new Map([...current, ...now.map((row) => [row.id, row] as const)]))
  })
  const rows = createMemo(() =>
    [...new Map([...kept(), ...open().map((row) => [row.id, row] as const)]).values()]
      .filter((row) => row.conversationId === props.conversationId)
      .toSorted((left, right) => left.askedAt - right.askedAt),
  )
  return (
    <For each={rows()}>
      {(row) => (
        <div class="px-3 pt-3" data-approval={row.id}>
          <PolicyApprovalCard request={row} />
        </div>
      )}
    </For>
  )
}

export const CONNECTORS_PATH = "/extensions/customize"

export function ConnectCard(call: Call): JSX.Element {
  const state = (): CardState => cardState(call)
  const sender = createSender()
  const service = (): string => text(call.args, "service")
  const report = (request: RequestRow, answer: "connected" | "declined"): void =>
    void sender.send(() => respondToQuestion(request, answer))
  return (
    <CardFrame icon="link" title={`Connect ${service()}`} label={`Connect ${service()}`} state={state()}>
      <p class="text-sm leading-[1.6] text-ink-2">{text(call.args, "reason")}</p>
      <Show when={openOf(state())} fallback={<Outcome state={state()} answered={() => `${service()} connected`} />}>
        {(request) => (
          <>
            <p class="text-sm leading-[1.6] text-ink-3">
              Add it as a connector or a provider key, then come back and confirm.
            </p>
            <div class="flex flex-wrap gap-2">
              <Button size="sm" class="im-focus im-press" onClick={() => navigate(CONNECTORS_PATH)}>
                <Icon name="settings" size={14} />
                Open connectors
              </Button>
              <Button size="sm" variant="primary" class="im-focus im-press" disabled={sender.sending()} onClick={() => report(request(), "connected")}>
                It's connected
              </Button>
              <Button size="sm" variant="quiet" class="im-focus im-press" disabled={sender.sending()} onClick={() => report(request(), "declined")}>
                Decline
              </Button>
            </div>
            <SendLine sending={sender.sending()} error={sender.error()} />
          </>
        )}
      </Show>
    </CardFrame>
  )
}

/** The value lives only in the input element: the card never keeps it in state, and clears the field once it is sent. */
export function SecretCard(call: Call): JSX.Element {
  const state = (): CardState => cardState(call)
  const sender = createSender()
  const name = (): string => text(call.args, "name")
  const [filled, setFilled] = createSignal(false)
  let field: HTMLInputElement | undefined
  const store = (request: RequestRow): void => {
    const value = field?.value ?? ""
    if (value === "") return
    if (field !== undefined) field.value = ""
    setFilled(false)
    void sender.send(() => provideSecret(request, name(), value))
  }
  return (
    <CardFrame icon="key" title={text(call.args, "label") || name()} label={`Secret ${name()}`} state={state()}>
      <p class="text-sm leading-[1.6] text-ink-2">{text(call.args, "reason")}</p>
      <Show
        when={openOf(state())}
        fallback={<Outcome state={state()} answered={() => `Stored as ${name()}`} />}
      >
        {(request) => (
          <>
            <form
              class="flex items-center gap-2"
              autocomplete="off"
              onSubmit={(event) => {
                event.preventDefault()
                store(request())
              }}
            >
              <input
                ref={field}
                type="password"
                autocomplete="new-password"
                spellcheck={false}
                aria-label={`Value for ${name()}`}
                disabled={sender.sending()}
                onInput={(event) => setFilled(event.currentTarget.value !== "")}
                placeholder="Paste the value"
                class={`${FIELD} font-mono`}
              />
              <Button type="submit" size="sm" variant="primary" class="im-focus" disabled={sender.sending() || !filled()}>
                Save
              </Button>
              <Button
                size="sm"
                variant="quiet"
                class="im-focus"
                disabled={sender.sending()}
                onClick={() => void sender.send(() => provideSecret(request(), name(), undefined))}
              >
                Decline
              </Button>
            </form>
            <p class="flex items-center gap-1.5 text-2xs text-ink-3">
              <Icon name="key" size={12} />
              Saved to your secrets as <span class="font-mono text-ink-2">{name()}</span>. The agent never sees it.
            </p>
            <SendLine sending={sender.sending()} error={sender.error()} />
          </>
        )}
      </Show>
    </CardFrame>
  )
}

/** The tools whose calls render as cards, by tool name: also the request kinds the thread's own transcript answers. */
export const CARD_TOOLS = {
  ask_user: AskCard,
  request_approval: ApprovalCard,
  request_connection: ConnectCard,
  request_secret: SecretCard,
} as const
