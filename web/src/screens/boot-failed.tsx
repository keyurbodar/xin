import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { repair, type RepairReport } from "../lib/api.ts"
import { probe, token } from "../lib/auth.ts"
import { errorMessage } from "../state/extensions.ts"
import { Button } from "../components/ui/button.tsx"
import { Failure } from "../components/ui/state.tsx"
import { Glyph } from "../components/extensions/glyph.tsx"

type Drop = "journal" | "all"

type Action = {
  readonly drop: Drop
  readonly title: string
  readonly detail: (report: RepairReport) => string
  readonly confirm: string
}

const ACTIONS: readonly Action[] = [
  {
    drop: "journal",
    title: "Drop the journal",
    detail: (report) =>
      `Discards the ${count(report.journal, "change")} written since the last checkpoint and opens the home from that checkpoint.`,
    confirm: "Drop journal",
  },
  {
    drop: "all",
    title: "Start from empty",
    detail: () =>
      "Discards the checkpoint and the journal too, so everything pi keeps (conversations and their transcripts) is gone and the home opens empty.",
    confirm: "Drop everything",
  },
]

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`
}

export function BootFailedScreen(props: {
  failure: string
  onRecovered: () => void
  onSignedOut: () => void
}): JSX.Element {
  const [failure, setFailure] = createSignal(props.failure)
  const [report, setReport] = createSignal<RepairReport | undefined>(undefined)
  const [refused, setRefused] = createSignal<number | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [confirming, setConfirming] = createSignal<Drop | undefined>(undefined)
  const [busy, setBusy] = createSignal<Drop | "check" | undefined>(undefined)
  const [copied, setCopied] = createSignal(false)

  const run = async (drop?: Drop): Promise<void> => {
    setBusy(drop ?? "check")
    setError(undefined)
    try {
      const answer = await repair(drop)
      if (answer.kind === "open") {
        props.onRecovered()
        return
      }
      if (answer.kind === "refused") {
        setRefused(answer.status)
        return
      }
      if (answer.report.failure === null) {
        props.onRecovered()
        return
      }
      setFailure(answer.report.failure)
      setReport(answer.report)
      setConfirming(undefined)
    } catch (thrown: unknown) {
      setError(errorMessage(thrown))
    } finally {
      setBusy(undefined)
    }
  }

  const check = async (): Promise<void> => {
    setBusy("check")
    const answer = await probe(token())
    setBusy(undefined)
    if (answer.kind === "ok") props.onRecovered()
    else if (answer.kind === "boot_failed") {
      setFailure(answer.failure)
      void run()
    } else if (answer.kind === "unreachable") setError("The Worker didn’t answer. Check the network and try again.")
  }

  onMount(() => void run())

  const copy = async (): Promise<void> => {
    const stored = report()
    const lines = [`failure: ${failure()}`]
    if (stored !== undefined) lines.push(`journal: ${stored.journal}`, `checkpoint: ${stored.checkpoint}`)
    try {
      await navigator.clipboard.writeText(lines.join("\n"))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError("The browser refused the clipboard; the failure is shown in full above.")
    }
  }

  const offered = (stored: RepairReport): readonly Action[] =>
    ACTIONS.filter((action) => (action.drop === "journal" ? stored.journal > 0 : stored.checkpoint > 0))

  return (
    <div class="fixed inset-0 z-50 flex flex-col bg-bg text-ink" role="alertdialog" aria-labelledby="boot-title">
      <div class="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-16 pt-[12vh]">
        <div class="im-stagger flex w-full max-w-[560px] flex-col">
          <div class="flex items-center gap-2 text-sm text-failed">
            <span class="sig" data-size="16" data-state="failed" aria-hidden="true">
              <i /><i /><i /><i /><i /><i /><i /><i /><i />
            </span>
            Home didn’t open
          </div>
          <h1 id="boot-title" class="mt-3 text-2xl font-semibold tracking-[-0.02em]" style={{ "--i": 1 }}>
            Your home can’t start
          </h1>
          <p class="mt-2 text-base text-ink-3" style={{ "--i": 2 }}>
            The Worker is up, but the Durable Object that keeps your home threw while opening. Until it opens it answers
            only repair, so nothing below changes anything until you choose to.
          </p>

          <div class="mt-6 overflow-hidden rounded-lg border border-failed/30 bg-panel" style={{ "--i": 3 }}>
            <div class="flex h-9 items-center gap-2 border-b border-line-1 px-3.5">
              <span class="text-xs font-medium text-ink-3">What it said</span>
              <button
                type="button"
                class="im-press ml-auto inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink"
                onClick={() => void copy()}
              >
                <Glyph name={copied() ? "check" : "copy"} size={13} />
                {copied() ? "Copied" : "Copy details"}
              </button>
            </div>
            <pre class="max-h-[160px] overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-xs leading-relaxed text-ink-2">
              {failure()}
            </pre>
            <Show when={report()}>
              {(stored) => (
                <div class="grid grid-cols-2 border-t border-line-1">
                  <div class="border-r border-line-1 px-3.5 py-2.5">
                    <span class="block text-xs text-ink-3">Journal since checkpoint</span>
                    <span class="mt-0.5 block font-mono text-sm text-ink">{count(stored().journal, "row")}</span>
                  </div>
                  <div class="px-3.5 py-2.5">
                    <span class="block text-xs text-ink-3">Checkpoint</span>
                    <span class="mt-0.5 block font-mono text-sm text-ink">
                      {stored().checkpoint === 0 ? "none" : count(stored().checkpoint, "row")}
                    </span>
                  </div>
                </div>
              )}
            </Show>
          </div>

          <Show when={refused()}>
            {(status) => (
              <div class="mt-4 flex flex-col gap-3 rounded-lg border border-line-2 bg-panel px-3.5 py-3" style={{ "--i": 4 }}>
                <p class="text-sm text-ink-2">
                  The home refused repair (HTTP {status()}). Repair is checked against the deploy’s{" "}
                  <span class="font-mono text-xs text-ink">OWNER_TOKEN</span>, because a rotated token is verified by the
                  home that can’t open.
                </p>
                <div>
                  <Button size="sm" onClick={props.onSignedOut}>
                    Sign in with the deploy token
                  </Button>
                </div>
              </div>
            )}
          </Show>

          <span class="mt-8 text-sm font-medium text-ink" style={{ "--i": 4 }}>
            Repair
          </span>
          <div class="mt-2 overflow-hidden rounded-lg border border-line-1 bg-panel" style={{ "--i": 5 }}>
            <div class="flex items-center gap-4 border-b border-line-1 px-3.5 py-3 last:border-0">
              <div class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-ink">Check again</span>
                <span class="mt-0.5 block text-xs leading-snug text-ink-3">
                  Changes nothing. A deploy restarts the home, so check after shipping a fix.
                </span>
              </div>
              <Button size="sm" class="im-press" disabled={busy() !== undefined} onClick={() => void check()}>
                <Glyph name="refresh" size={14} />
                {busy() === "check" ? "Checking" : "Check again"}
              </Button>
            </div>
            <Show when={report()}>
              {(stored) => (
                <For each={offered(stored())}>
                  {(action) => (
                    <div class="flex flex-col gap-2.5 border-b border-line-1 px-3.5 py-3 last:border-0">
                      <div class="flex items-center gap-4">
                        <div class="min-w-0 flex-1">
                          <span class="block text-sm font-medium text-ink">{action.title}</span>
                          <span class="mt-0.5 block text-xs leading-snug text-ink-3">{action.detail(stored())}</span>
                        </div>
                        <Show when={confirming() !== action.drop}>
                          <Button
                            size="sm"
                            variant="danger"
                            class="im-press"
                            disabled={busy() !== undefined || refused() !== undefined}
                            onClick={() => setConfirming(action.drop)}
                          >
                            <Glyph name="trash" size={14} />
                            {action.title}
                          </Button>
                        </Show>
                      </div>
                      <Show when={confirming() === action.drop}>
                        <div class="im-arrive flex items-center gap-2 rounded-md bg-failed-soft px-3 py-2">
                          <Glyph name="warning" size={14} class="shrink-0 text-failed" />
                          <span class="min-w-0 flex-1 text-xs text-ink-2">This can’t be undone.</span>
                          <Button size="sm" variant="quiet" onClick={() => setConfirming(undefined)}>
                            Keep
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            class="im-press"
                            disabled={busy() !== undefined}
                            onClick={() => void run(action.drop)}
                          >
                            {busy() === action.drop ? "Dropping" : action.confirm}
                          </Button>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              )}
            </Show>
          </div>

          <Show when={error()}>
            {(message) => (
              <div class="mt-4">
                <Failure message={message()} />
              </div>
            )}
          </Show>

          <p class="mt-4 text-xs leading-relaxed text-ink-3">
            Credentials, files, settings and plugin rows live in the home’s own tables and survive both drops. If a drop
            doesn’t clear the failure, the cause is in code, not stored state: copy the details into an issue.
          </p>
        </div>
      </div>
    </div>
  )
}
