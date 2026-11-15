import { createEffect, createSignal, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { probe, token } from "../lib/auth.ts"
import { ago } from "../lib/format.ts"
import { connectionState, disconnectedSince, lastConnected, networkOnline, nextRetry, reauthorize } from "../state/connection.ts"
import { Button } from "../components/ui/button.tsx"
import { Pictogram } from "../components/ui/pictogram.tsx"
import { Glyph } from "../components/extensions/glyph.tsx"

const CUT_OFF_MS = 10_000

/** The banner covers a short drop; past ten seconds without a socket, or with no network at all, the app is cut off. */
export function cutOff(): Accessor<boolean> {
  const [late, setLate] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    clearTimeout(timer)
    const since = disconnectedSince()
    setLate(false)
    if (since === undefined) return
    timer = setTimeout(() => setLate(true), Math.max(0, since + CUT_OFF_MS - Date.now()))
  })
  onCleanup(() => clearTimeout(timer))
  return () => !networkOnline() || late()
}

export function OfflineScreen(props: { onBootFailed: (failure: string) => void; onSignedOut: () => void }): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const [checking, setChecking] = createSignal(false)
  const ticker = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(ticker))

  /** One status read tells a home that cannot open, or a token rotated elsewhere, from a dropped socket. */
  const socketIsTheProblem = async (): Promise<boolean> => {
    const answer = await probe(token())
    if (answer.kind === "boot_failed") props.onBootFailed(answer.failure)
    if (answer.kind === "unauthorized") props.onSignedOut()
    return answer.kind === "ok" || answer.kind === "unreachable"
  }

  onMount(() => {
    if (networkOnline()) void socketIsTheProblem()
  })

  const reconnect = async (): Promise<void> => {
    setChecking(true)
    if (await socketIsTheProblem()) reauthorize()
    setChecking(false)
  }

  const seconds = (): number | undefined => {
    const at = nextRetry()
    return at === undefined ? undefined : Math.max(0, Math.ceil((at - now()) / 1000))
  }

  const status = (): string => {
    if (checking() || connectionState() === "connecting") return "Connecting"
    if (!networkOnline()) return "Waiting for the network"
    const left = seconds()
    return left === undefined || left === 0 ? "Trying again" : `Trying again in ${left} s`
  }

  return (
    <div class="fixed inset-0 z-50 flex flex-col bg-bg text-ink" role="alertdialog" aria-labelledby="offline-title">
      <div class="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-16 pt-[18vh]">
        <div class="im-stagger flex w-full max-w-[440px] flex-col items-center text-center">
          <Pictogram name="offline" size={88} />
          <h1 id="offline-title" class="mt-6 text-2xl font-semibold tracking-[-0.02em]" style={{ "--i": 1 }}>
            {networkOnline() ? "Can’t reach your home" : "You’re offline"}
          </h1>
          <p class="mt-2 max-w-[360px] text-base text-ink-3" style={{ "--i": 2 }}>
            {networkOnline()
              ? "The network is up, but the Worker isn’t answering the live connection."
              : "This device has no network. Ingle reconnects on its own as soon as it’s back."}
          </p>

          <div class="mt-5 flex h-7 items-center gap-2 rounded-full border border-line-2 px-3 text-sm text-ink-2" style={{ "--i": 3 }}>
            <span class="sig" data-size="12" data-state="waiting" aria-hidden="true">
              <i /><i /><i /><i /><i /><i /><i /><i /><i />
            </span>
            <span aria-live="polite">{status()}</span>
            <Show when={checking() || connectionState() === "connecting"}>
              <span class="im-dots" aria-hidden="true">
                <i /><i /><i />
              </span>
            </Show>
          </div>

          <div class="mt-6 flex items-center gap-2" style={{ "--i": 4 }}>
            <Button variant="primary" class="im-press" disabled={checking()} onClick={() => void reconnect()}>
              <Glyph name="refresh" size={15} />
              Reconnect now
            </Button>
            <Button variant="quiet" class="im-press" onClick={() => location.reload()}>
              Reload page
            </Button>
          </div>

          <dl class="mt-8 w-full overflow-hidden rounded-lg border border-line-1 bg-panel text-left text-sm" style={{ "--i": 5 }}>
            <div class="flex items-center gap-3 border-b border-line-1 px-3.5 py-2.5">
              <dt class="text-ink-3">Network</dt>
              <dd class="ml-auto" classList={{ "text-done": networkOnline(), "text-failed": !networkOnline() }}>
                {networkOnline() ? "Online" : "Offline"}
              </dd>
            </div>
            <div class="flex items-center gap-3 px-3.5 py-2.5">
              <dt class="text-ink-3">Last connected</dt>
              <dd class="ml-auto font-mono text-xs text-ink-2">
                {lastConnected() === undefined ? "never in this tab" : `${ago(lastConnected(), now())} ago`}
              </dd>
            </div>
          </dl>
          <p class="mt-3 text-xs leading-relaxed text-ink-3" style={{ "--i": 5 }}>
            Threads keep running on your home while this tab is away. What you had open stays behind this screen and
            catches up when the connection returns.
          </p>
        </div>
      </div>
    </div>
  )
}
