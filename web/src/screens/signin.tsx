import { createSignal, onMount, type JSX } from "solid-js"
import { setToken, verifyToken } from "../lib/auth.ts"
import { OnboardingTopBar, type RailItem } from "../components/onboarding/chrome.tsx"
import { FIELD_ROW } from "../components/ui/field.ts"

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
    const accepted = await verifyToken(value().trim())
    setBusy(false)
    if (!accepted) {
      setError("That token doesn’t match this instance.")
      return
    }
    setToken(value().trim())
    props.onSignedIn()
  }

  return (
    <div class="flex h-full flex-col bg-page text-fg">
      <OnboardingTopBar items={STEPS} />
      <div class="atmos flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pb-16 pt-[22vh]">
        <form
          onSubmit={submit}
          class="enter w-full max-w-[560px] rounded-[20px] border border-line-inner bg-raised p-6 shadow-[var(--shadow-float)] sm:p-8"
        >
          <div class="label">Owner access</div>
          <h1 class="type-section mt-3">Sign in to your workspace</h1>
          <p class="mt-3 text-[13.5px] leading-[1.6] text-fg-3">
            This instance belongs to one owner. Paste the owner token from your deploy output to unlock it.
          </p>

          <div class="mt-6 flex flex-col gap-1.5">
            <span class="text-[12.5px] font-medium text-fg-2">Owner token</span>
            <div
              class={`${FIELD_ROW} w-full`}
              classList={{ "border-bad focus-within:border-bad": error() !== undefined && !busy() }}
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
                class="h-full min-w-0 flex-1 bg-transparent font-mono text-[12.5px] tracking-[0.08em] text-fg placeholder:tracking-normal placeholder:text-fg-4 focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setRevealed((shown) => !shown)}
                class="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3 hover:text-fg"
              >
                {revealed() ? "Hide" : "Show"}
              </button>
            </div>
            <span class="text-[12.5px] leading-[1.5] text-fg-3">
              The token stays in this browser. Rotate it any time under Settings, Profile + token.
            </span>
          </div>

          <p class="mt-2 min-h-4 text-[12.5px] leading-4 text-bad" role="alert">
            {error() ?? ""}
          </p>

          <button
            type="submit"
            disabled={busy() || value().trim() === ""}
            aria-busy={busy()}
            class="mt-3 inline-flex h-8 w-full items-center justify-center gap-2 rounded-[8px] bg-accent text-[13.5px] font-medium text-ink enabled:hover:bg-accent disabled:opacity-40"
          >
            {busy() ? (
              <>
                <span class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-ink/25 border-t-ink" />
                Checking…
              </>
            ) : (
              "Continue"
            )}
          </button>

          <p class="mt-4 text-center text-[11.5px] leading-[1.5] text-fg-3">
            Lost the token? Read <span class="font-mono text-[11px] text-fg-2">OWNER_TOKEN</span> from the deployment’s
            secrets.
          </p>
        </form>
      </div>
    </div>
  )
}
