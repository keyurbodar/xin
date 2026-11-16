import "../../src/styles/app.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { trackMotion } from "../../src/lib/motion.ts"
import type { ChatMessage, EntryView, Snapshot } from "../../src/state/conversation.ts"
import type { ProjectSummary, ThreadSummary } from "../../src/state/home.ts"
import { registerBlock } from "../../src/components/chat/blocks.tsx"
import { Transcript, type PendingMessage } from "../../src/components/chat/transcript.tsx"

type Part = Readonly<Record<string, unknown>>
type Slot = { readonly callId: string; readonly name: string; readonly status: string; readonly output?: string }
type Live = { readonly busy: boolean; readonly content: readonly Part[]; readonly tools: readonly Slot[] }

const NOW = new Date().setHours(9, 30, 0, 0)
const YESTERDAY = NOW - 24 * 3600_000

let nextId = 1
const text = (value: string): Part => ({ type: "text", text: value })
const call = (id: string, name: string, args: Part): Part => ({ type: "toolCall", id, name, arguments: args })
const entry = (kind: string, model: readonly ChatMessage[], data?: unknown): EntryView => ({ id: nextId++, kind, model, data })
const user = (at: number, value: string): EntryView =>
  entry("xin.batch", [], [{ id: nextId, body: { kind: "user", text: value }, clientTs: at }])
const assistant = (at: number, content: readonly Part[]): EntryView => entry("pi.assistant", [{ role: "assistant", content, timestamp: at }])
const result = (at: number, toolCallId: string, output: string, extra: Partial<ChatMessage> = {}): EntryView =>
  entry("pi.tool-result", [{ role: "toolResult", toolCallId, content: [text(output)], timestamp: at, ...extra }])

const LONG =
  "The refresh path reads the stored token, checks its expiry and, when it is close, asks the provider for a new one. Two tabs could both see an expiring token and both refresh; the provider rotates on each refresh, so the slower tab saved a token that was already revoked."

const history: EntryView[] = [
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
  entry("pi.tool-result", [{ role: "toolResult", toolCallId: "c6", content: [text("Started thread 23")], threadId: 23, details: { threadId: 23 }, timestamp: YESTERDAY + 80_000 }]),
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
  assistant(NOW - 548_000, [text("I asked Release notes to draft the changelog entry.")]),
]

const thread = (id: number, title: string, status: string): ThreadSummary => ({ id, title, status, run: 1 })
const projectWith = (releaseStatus: string): ProjectSummary => ({
  id: "p1",
  slug: "auth",
  name: "Auth",
  archived: false,
  coordinatorId: 1,
  threads: {
    working: releaseStatus === "working" ? [thread(31, "Release notes", "working")] : [],
    waiting: [],
    completed: [thread(19, "Docs pass", "completed"), thread(23, "Regression tests", "completed"), ...(releaseStatus === "working" ? [] : [thread(31, "Release notes", "completed")])],
    failed: [],
    cancelled: [],
  },
  openRequests: 0,
  requestsRev: 0,
  spaces: [],
})

const [entries, setEntries] = createSignal<readonly EntryView[]>(history)
const [live, setLive] = createSignal<Live>({ busy: false, content: [], tools: [] })
const [project, setProject] = createSignal(projectWith("working"))
const [pending, setPending] = createSignal<readonly PendingMessage[]>([])
const [older, setOlder] = createSignal<readonly EntryView[]>([])
const [hasOlder, setHasOlder] = createSignal(false)
let pages: EntryView[][] = []
const sameDay = (at: number, ask: string): EntryView[] => [
  user(at, ask),
  assistant(at + 4_000, [text("Everything is green: the last deploy finished and every check passed. Nothing needs you.")]),
]

const snapshot = (): Snapshot => {
  const now = live()
  return {
    id: 1,
    entries: entries(),
    before: undefined,
    docs: {
      "pi.live": now.busy
        ? { run: { taskId: "t", inputs: [], turns: 0 }, generation: { attempt: 1, message: { role: "assistant", content: now.content } }, tools: now.tools }
        : {},
    },
  }
}

const commit = (...added: EntryView[]): void => {
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
    blockVisuals: () =>
      registerBlock("tool:visualize", (payload) => (
        <div data-test-block={payload.callId} class="rounded-md bg-secondary px-3 py-2 text-small text-ink-2">
          {String(payload.args.title)} ({payload.status})
        </div>
      )),
    longer: () => commit(assistant(NOW + 90_000, [text(LONG)])),
    stopWaiting: () => setProject(projectWith("completed")),
    reconnect: () => setEntries((current) => structuredClone(current)),
    paginate: () => {
      const today = history.findIndex((item) => item.kind === "xin.batch" && item.id > 1)
      pages = [history.slice(0, today), sameDay(NOW - 3 * 3600_000, "Check the deploy status."), sameDay(NOW - 2 * 3600_000, "Is staging healthy?")]
      setEntries(history.slice(today))
      setHasOlder(true)
    },
  },
})

function App() {
  const send = (text: string): void => {
    setPending((current) => [...current, { key: `p${current.length}`, text, at: NOW, attachments: [] }])
  }
  return (
    <main class="flex h-screen flex-col bg-bg">
      <Transcript
        snapshot={snapshot()}
        project={project()}
        optimistic={pending()}
        older={older()}
        hasOlder={hasOlder()}
        requests={[]}
        answered={[]}
        onOpenThread={() => undefined}
        onAnswer={async () => undefined}
        onRetry={async () => undefined}
        onLoadOlder={async () => {
          const page = pages.pop() ?? []
          setOlder((current) => [...page, ...current])
          setHasOlder(pages.length > 0)
        }}
      />
      <form
        class="mx-auto mb-4 flex w-full max-w-[var(--w-column)] px-6"
        onSubmit={(event) => {
          event.preventDefault()
          const field = event.currentTarget.elements.namedItem("message")
          if (!(field instanceof HTMLTextAreaElement) || field.value.trim() === "") return
          send(field.value)
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
