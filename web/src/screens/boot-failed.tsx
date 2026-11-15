import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { repair } from "../lib/api.ts"
import { probe, token } from "../lib/auth.ts"
import { confirmed, KEPT, repairOffers, type Drop, type RepairOffer, type RepairReport } from "../lib/repair.ts"
import { errorMessage } from "../state/extensions.ts"
import { Button } from "../components/ui/button.tsx"
import { Failure } from "../components/ui/state.tsx"
import { Signal } from "../components/ui/signal.tsx"
import { Glyph } from "../components/extensions/glyph.tsx"

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
      if (answer.kind === "unauthorized") {
        props.onSignedOut()
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

  return (
    <div class="fixed inset-0 z-50 flex flex-col bg-bg text-ink" role="alertdialog" aria-labelledby="boot-title">
      <div class="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-16 pt-[12vh]">
        <div class="im-stagger flex w-full max-w-[560px] flex-col">
          <div class="flex items-center gap-2 text-sm text-failed">
            <Signal state="failed" size={16} />
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
                    <span class="block text-xs text-ink-3">{stored().checkpoint === 0 ? "Journal" : "Journal since checkpoint"}</span>
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
                <For each={repairOffers(stored())}>
                  {(offer) => (
                    <OfferRow
                      offer={offer}
                      open={confirming() === offer.drop}
                      busy={busy()}
                      onOpen={() => setConfirming(offer.drop)}
                      onClose={() => setConfirming(undefined)}
                      onConfirm={() => void run(offer.drop)}
                    />
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
            {KEPT} If a drop doesn’t clear the failure, the cause is in code, not stored state: copy the details into an
            issue.
          </p>
        </div>
      </div>
    </div>
  )
}

function OfferRow(props: {
  offer: RepairOffer
  open: boolean
  busy: Drop | "check" | undefined
  onOpen: () => void
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  let opener: HTMLSpanElement | undefined

  const close = (): void => {
    props.onClose()
    requestAnimationFrame(() => opener?.querySelector<HTMLElement>("button")?.focus())
  }

  return (
    <div class="flex flex-col gap-2.5 border-b border-line-1 px-3.5 py-3 last:border-0">
      <div class="flex items-center gap-4">
        <div class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-ink">{props.offer.title}</span>
          <span class="mt-0.5 block text-xs leading-snug text-ink-3">{props.offer.detail}</span>
        </div>
        <span ref={opener} class="shrink-0">
          <Button
            size="sm"
            variant="danger"
            class="im-press"
            disabled={props.busy !== undefined || props.open}
            onClick={props.onOpen}
          >
            <Glyph name="trash" size={14} />
            {props.offer.title}
          </Button>
        </span>
      </div>
      <Show when={props.open}>
        <Confirm offer={props.offer} busy={props.busy === props.offer.drop} onClose={close} onConfirm={props.onConfirm} />
      </Show>
    </div>
  )
}

function Confirm(props: { offer: RepairOffer; busy: boolean; onClose: () => void; onConfirm: () => void }): JSX.Element {
  const [typed, setTyped] = createSignal("")
  let box: HTMLDivElement | undefined

  onMount(() => box?.querySelector<HTMLElement>("input, button")?.focus())

  const ready = (): boolean => confirmed(props.offer, typed())

  return (
    <div
      ref={box}
      role="group"
      aria-label={`Confirm ${props.offer.title}`}
      class="im-arrive flex flex-col gap-2 rounded-md bg-failed-soft px-3 py-2.5"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        props.onClose()
      }}
    >
      <div class="flex items-center gap-2">
        <Glyph name="warning" size={14} class="shrink-0 text-failed" />
        <span class="min-w-0 flex-1 text-xs text-ink-2">
          This can’t be undone.
          <Show when={props.offer.word}>{(word) => <> Type <span class="font-mono text-ink">{word()}</span> to confirm.</>}</Show>
        </span>
      </div>
      <form
        class="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready() && !props.busy) props.onConfirm()
        }}
      >
        <Show when={props.offer.word}>
          {(word) => (
            <input
              value={typed()}
              onInput={(event) => setTyped(event.currentTarget.value)}
              aria-label={`Type ${word()} to confirm`}
              placeholder={word()}
              spellcheck={false}
              autocomplete="off"
              class="h-7 min-w-0 flex-1 rounded-sm border border-failed/40 bg-bg px-2 font-mono text-xs text-ink placeholder:text-placeholder focus:border-failed focus:outline-none"
            />
          )}
        </Show>
        <span class="ml-auto flex items-center gap-2">
          <Button size="sm" variant="quiet" onClick={props.onClose}>
            Keep
          </Button>
          <Button size="sm" variant="danger" type="submit" class="im-press" disabled={props.busy || !ready()}>
            {props.busy ? "Dropping" : props.offer.confirm}
          </Button>
        </span>
      </form>
    </div>
  )
}
