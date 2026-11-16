import "../../src/styles/app.css"
import { createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { trackMotion } from "../../src/lib/motion.ts"
import type { Snapshot } from "../../src/state/conversation.ts"
import { ReportCard, SystemNotice } from "../../src/components/chat/cards.tsx"
import { hasBlock, registerBlock } from "../../src/components/chat/timeline/blocks-port.ts"
import {
  buildTimeline,
  liveTimelineOf,
  waitTarget,
  type TimedMessage,
  type TimelineEntry,
  type TimelineLink,
} from "../../src/components/chat/timeline/model.ts"
import { Timeline } from "../../src/components/chat/timeline/timeline.tsx"

type Part = Readonly<Record<string, unknown>>
type Slot = { readonly callId: string; readonly name: string; readonly status: string; readonly output?: string }
type Live = { readonly busy: boolean; readonly content: readonly Part[]; readonly tools: readonly Slot[] }

const NOW = new Date(2026, 10, 16, 9, 30).getTime()
const YESTERDAY = NOW - 24 * 3600_000
const TITLES = new Map([
  [19, "Docs pass"],
  [23, "Regression tests"],
  [31, "Release notes"],
])

let nextId = 1
const text = (value: string): Part => ({ type: "text", text: value })
const call = (id: string, name: string, args: Part): Part => ({ type: "toolCall", id, name, arguments: args })
const entry = (kind: string, model: readonly TimedMessage[], data?: unknown): TimelineEntry => ({ id: nextId++, kind, model, data })
const user = (at: number, value: string): TimelineEntry =>
  entry("xin.batch", [], [{ id: nextId, body: { kind: "user", text: value }, clientTs: at }])
const assistant = (at: number, content: readonly Part[]): TimelineEntry => entry("pi.assistant", [{ role: "assistant", content, timestamp: at }])
const result = (at: number, toolCallId: string, output: string, extra: Partial<TimedMessage> = {}): TimelineEntry =>
  entry("pi.tool-result", [{ role: "toolResult", toolCallId, content: [text(output)], timestamp: at, ...extra }])

const LONG =
  "The refresh path reads the stored token, checks its expiry and, when it is close, asks the provider for a new one. Two tabs could both see an expiring token and both refresh; the provider rotates on each refresh, so the slower tab saved a token that was already revoked."

const history: TimelineEntry[] = [
  user(YESTERDAY, "Audit the auth flow and fix the token refresh bug people hit after lunch."),
  assistant(YESTERDAY + 4_000, [
    text("I'll read the auth module and the session store first."),
    call("c1", "read", { path: "src/auth.ts" }),
    call("c2", "read", { path: "src/session.ts" }),
  ]),
  result(YESTERDAY + 6_000, "c1", "export async function refresh(session: Session) {\n  const token = await store.get(session.id)\n  …\n}"),
  result(YESTERDAY + 7_000, "c2", "export const store = new KvStore('sessions')"),
  assistant(YESTERDAY + 12_000, [
    call("c3", "web_search", { query: "refresh token rotation race two tabs" }),
    call("c4", "bash", { command: "bun test src/auth.test.ts" }),
  ]),
  result(YESTERDAY + 20_000, "c3", "1. Auth0: Refresh token rotation…"),
  result(YESTERDAY + 40_000, "c4", "1 fail: refresh twice in parallel keeps a revoked token", { isError: true }),
  assistant(YESTERDAY + 60_000, [
    text(`Found it. ${LONG}\n\nI made refresh single-flight per session, so a second caller waits for the first refresh instead of starting its own.`),
    call("c5", "edit", { path: "src/auth.ts", old: "const token = await store.get", new: "return inflight.get(session.id) ?? start(session)" }),
    call("c6", "delegate_task", { title: "Regression tests", task: "Add a parallel refresh regression test." }),
  ]),
  result(YESTERDAY + 70_000, "c5", "Edited src/auth.ts"),
  entry("pi.tool-result", [{ role: "toolResult", toolCallId: "c6", content: [text("Started thread 23")], threadId: 23, timestamp: YESTERDAY + 80_000 }]),
  assistant(YESTERDAY + 87_000, [text("The fix is in, and a thread is writing the regression test. I'll report back when it lands.")]),
  entry(
    "xin.batch",
    [],
    [
      { id: 90, body: { kind: "report", text: "Added refresh.parallel.test.ts; it fails before the fix and passes after.", threadId: "23", title: "Regression tests", status: "completed" }, clientTs: NOW - 600_000 },
      { id: 91, body: { kind: "report", text: "Updated docs/auth.md with the single-flight note.", threadId: "19", title: "Docs pass", status: "completed" }, clientTs: NOW - 590_000 },
    ],
  ),
  assistant(NOW - 570_000, [
    text("Both threads are done: the regression test fails before the fix and passes after it, and the docs explain the single-flight refresh."),
    call("c7", "thread_send", { threadId: 31, text: "Draft release notes for the refresh fix.", mode: "queue" }),
  ]),
  result(NOW - 560_000, "c7", "Sent to thread 31"),
  entry("xin.fallback", [], {
    from: { provider: "alpha", modelId: "alpha-large" },
    to: { provider: "beta", modelId: "beta-fast" },
    error: "529 overloaded_error: the model is overloaded",
  }),
  assistant(NOW - 548_000, [text("I asked Release notes to draft the changelog entry.")]),
]

const [entries, setEntries] = createSignal<readonly TimelineEntry[]>(history)
const [live, setLive] = createSignal<Live>({ busy: false, content: [], tools: [] })
const [working, setWorking] = createSignal<readonly TimelineLink[]>([{ threadId: 31, label: "Release notes" }])
const [pending, setPending] = createSignal<readonly { readonly key: string; readonly text: string }[]>([])

const snapshot = (): Snapshot => {
  const now = live()
  return {
    id: 1,
    entries: [],
    before: undefined,
    docs: {
      "pi.live": now.busy
        ? { run: { taskId: "t", inputs: [], turns: 0 }, generation: { attempt: 1, message: { role: "assistant", content: now.content } }, tools: now.tools }
        : {},
    },
  }
}

const commit = (...added: TimelineEntry[]): void => {
  setEntries((current) => [...current, ...added])
}

const GATE = "bun scripts/gate.ts submit lint types test --only=web"
const FINAL =
  "Shipped. The gate is green and the changelog has the entry:\n\n- **auth**: refresh is single-flight per session, so two tabs never keep a revoked token.\n- **tests**: `refresh.parallel.test.ts` covers the race.\n\nRelease notes is still polishing the wording; I'll forward it when it lands."

const steps: readonly (() => void)[] = [
  () => {
    commit(user(NOW, "Ship it and summarise the changes."))
    setLive({ busy: true, content: [], tools: [] })
  },
  () => setLive({ busy: true, content: [text("Shipping now. I'll run the gate first.")], tools: [] }),
  () => setLive({ busy: true, content: [text("Shipping now. I'll run the gate first."), call("l1", "bash", { command: "bun scripts/gate" })], tools: [] }),
  () => setLive({ busy: true, content: [text("Shipping now. I'll run the gate first."), call("l1", "bash", { command: GATE })], tools: [] }),
  () => {
    commit(assistant(NOW + 3_000, [text("Shipping now. I'll run the gate first."), call("l1", "bash", { command: GATE })]))
    setLive({ busy: true, content: [], tools: [{ callId: "l1", name: "bash", status: "running", output: "lint … ok" }] })
  },
  () => setLive({ busy: true, content: [], tools: [{ callId: "l1", name: "bash", status: "running", output: "lint … ok\ntypes … ok\ntest … 412 pass" }] }),
  () => {
    commit(result(NOW + 40_000, "l1", "lint … ok\ntypes … ok\ntest … 412 pass, 0 fail"))
    setLive({ busy: true, content: [call("l2", "read", { path: "CHANGELOG" })], tools: [] })
  },
  () => {
    commit(assistant(NOW + 42_000, [call("l2", "read", { path: "CHANGELOG.md" }), call("l3", "visualize", { title: "Refresh, before and after" })]))
    setLive({ busy: true, content: [], tools: [{ callId: "l2", name: "read", status: "running" }, { callId: "l3", name: "visualize", status: "running" }] })
  },
  () => {
    commit(result(NOW + 44_000, "l2", "## Unreleased\n"), result(NOW + 45_000, "l3", "rendered"))
    setLive({ busy: true, content: [text(FINAL.slice(0, 60))], tools: [] })
  },
  () => setLive({ busy: true, content: [text(FINAL.slice(0, 180))], tools: [] }),
  () => setLive({ busy: true, content: [text(FINAL)], tools: [] }),
  () => {
    commit(assistant(NOW + 87_000, [text(FINAL)]))
    setLive({ busy: false, content: [], tools: [] })
  },
]

let cursor = 0
let timer: ReturnType<typeof setInterval> | undefined
const next = (): boolean => {
  const step = steps[cursor]
  if (step === undefined) return false
  cursor += 1
  step()
  return true
}

Object.assign(window, {
  tl: {
    next,
    run: (count: number) => {
      for (let index = 0; index < count; index++) next()
    },
    finish: () => {
      while (next()) {}
    },
    play: (ms: number) => {
      timer = setInterval(() => {
        if (!next()) clearInterval(timer)
      }, ms)
    },
    send: (value: string) => setPending((current) => [...current, { key: `p${current.length}`, text: value }]),
    blockVisuals: () =>
      registerBlock("tool:visualize", (payload) => (
        <div data-test-block={payload.callId} class="rounded-md bg-secondary px-3 py-2 text-small text-ink-2">
          {String(payload.args.title)} ({payload.status})
        </div>
      )),
    longer: () => commit(assistant(NOW + 90_000, [text(LONG)])),
    stopWaiting: () => setWorking([]),
  },
})

function App() {
  const items = createMemo(() => [
    ...buildTimeline(entries(), liveTimelineOf(snapshot()), {
      hasBlock: (name) => hasBlock(`tool:${name}`),
      titles: TITLES,
      now: NOW,
    }),
    ...pending().map((message) => ({ kind: "owner" as const, key: message.key, text: message.text, attachments: [] })),
  ])
  const waiting = () => waitTarget({ live: liveTimelineOf(snapshot()), asking: false, threads: working() })
  return (
    <main class="flex h-screen flex-col bg-bg">
      <Timeline
        items={items()}
        waiting={waiting()}
        renderPass={(item) =>
          item.kind === "report" ? (
            <ReportCard row={item.row} onOpenThread={() => undefined} />
          ) : (
            <SystemNotice text={item.kind === "notice" ? item.text : item.kind} />
          )
        }
      />
      <form
        class="mx-auto mb-4 flex w-full max-w-[var(--w-column)] px-6"
        onSubmit={(event) => {
          event.preventDefault()
          const field = event.currentTarget.elements.namedItem("message")
          if (!(field instanceof HTMLTextAreaElement) || field.value.trim() === "") return
          setPending((current) => [...current, { key: `p${current.length}`, text: field.value }])
          field.value = ""
        }}
      >
        <div class="flex w-full items-end gap-2 rounded-lg bg-panel p-3 shadow-[var(--shadow-composer)]">
          <textarea id="composer" name="message" rows="1" placeholder="Message" class="min-h-8 flex-1 resize-none bg-transparent text-body text-ink outline-none placeholder:text-placeholder" />
          <button type="submit" class="h-8 rounded-sm bg-accent px-3 text-small text-on-accent">
            Send
          </button>
        </div>
      </form>
    </main>
  )
}

trackMotion()
render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
