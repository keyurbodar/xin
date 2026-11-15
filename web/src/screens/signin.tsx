import { createSignal, onMount, type JSX } from "solid-js"
import { probe, setToken } from "../lib/auth.ts"
import { OnboardingTopBar, type RailItem } from "../components/onboarding/chrome.tsx"

const STEPS: readonly RailItem[] = [
  { label: "Sign in", state: "current" },
  { label: "Model key", state: "todo" },
  { label: "First project", state: "todo" },
  { label: "First message", state: "todo" },
]

export function SignIn(props: { onSignedIn: () => void }): JSX.Element {
  const [value, setValue] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [revealed, setRevealed] = createSignal(false)

  /** The QR code links here with the token attached; it fills the field once and leaves the address bar clean. */
  onMount(() => {
    const query = window.location.hash.split("?")[1]
    const offered = new URLSearchParams(query ?? "").get("token")
    if (offered === null || offered === "") return
    setValue(offered)
    history.replaceState(null, "", `${window.location.pathname}#/signin`)
  })

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setError(undefined)
    const answer = await probe(value().trim())
    setBusy(false)
    if (answer.kind === "unauthorized") {
      setError("That token doesn’t match this instance.")
      return
    }
    if (answer.kind === "unreachable") {
      setError("This instance didn’t answer. Check the network and try again.")
      return
    }
    setToken(value().trim())
    props.onSignedIn()
  }

  return (
    <div class="flex h-full flex-col bg-bg text-ink">
      <OnboardingTopBar items={STEPS} />
      <div class="atmos flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pb-16 pt-[22vh]">
        <form onSubmit={submit} class="enter w-full max-w-[440px]">
          <div class="label">Owner access</div>
          <h1 class="mt-3 text-2xl font-light leading-[1.15] tracking-[-0.03em]">Sign in to your workspace</h1>
          <p class="mt-3 text-base leading-[1.6] text-ink-3">
            This instance belongs to one owner. Paste the owner token from your deploy output to unlock it.
          </p>

          <div class="mt-6 flex flex-col gap-1.5">
            <span class="text-sm font-medium text-ink-2">Owner token</span>
            <div
              class="flex h-10 items-center gap-2 rounded-sm border bg-panel px-3 focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(255,90,0,0.18)]"
              classList={{ "border-failed": error() !== undefined && !busy(), "border-line-2": error() === undefined || busy() }}
            >
              <input
                type={revealed() ? "text" : "password"}
                value={value()}
                onInput={(event) => {
                  setValue(event.currentTarget.value)
                  if (error() !== undefined) setError(undefined)
                }}
                autocomplete="current-password"
                spellcheck={false}
                placeholder="owner token"
                aria-label="Owner token"
                disabled={busy()}
                class="h-full min-w-0 flex-1 bg-transparent font-mono text-sm tracking-[0.08em] text-ink placeholder:tracking-normal placeholder:text-icon focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setRevealed((shown) => !shown)}
                class="shrink-0 font-mono text-2xs uppercase tracking-[0.08em] text-ink-3 hover:text-ink"
              >
                {revealed() ? "Hide" : "Show"}
              </button>
            </div>
            <span class="text-sm leading-[1.5] text-ink-3">
              The token stays in this browser. Rotate it any time under Settings, Profile + token.
            </span>
          </div>

          <p class="mt-2 min-h-4 text-sm leading-4 text-failed" role="alert">
            {error() ?? ""}
          </p>

          <button
            type="submit"
            disabled={busy() || value().trim() === ""}
            aria-busy={busy()}
            class="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-sm bg-primary text-base font-medium text-on-primary enabled:hover:bg-primary disabled:opacity-40"
          >
            {busy() ? (
              <>
                <span class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-on-primary/25 border-t-on-primary" />
                Checking…
              </>
            ) : (
              "Continue"
            )}
          </button>

          <p class="mt-4 text-center text-xs leading-[1.5] text-ink-3">
            Lost the token? Read <span class="font-mono text-2xs text-ink-2">OWNER_TOKEN</span> from the deployment’s
            secrets.
          </p>
        </form>
      </div>
    </div>
  )
}
