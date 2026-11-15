import { createSignal, onMount, Show, type JSX } from "solid-js"
import { Eye, EyeOff, KeyRound } from "lucide-solid"
import { setToken, verifyToken } from "../lib/auth.ts"
import { OnboardingFrame } from "../components/onboarding/chrome.tsx"
import { INPUT_BOX, PrimaryButton } from "../components/onboarding/controls.tsx"

const WRONG_TOKEN = "That token doesn’t match this instance. Check the last deploy output."

export function SignIn(props: { onSignedIn: () => void }): JSX.Element {
  const [value, setValue] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [revealed, setRevealed] = createSignal(false)

  onMount(() => {
    const query = window.location.hash.split("?")[1]
    const offered = new URLSearchParams(query ?? "").get("token")
    if (offered === null || offered === "") return
    setValue(offered)
    history.replaceState(null, "", `${window.location.pathname}#/signin`)
  })

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    const candidate = value().trim()
    if (busy() || candidate === "") return
    setBusy(true)
    setError(undefined)
    const accepted = await verifyToken(candidate)
    setBusy(false)
    if (!accepted) {
      setError(WRONG_TOKEN)
      return
    }
    setToken(candidate)
    props.onSignedIn()
  }

  return (
    <OnboardingFrame current={0} done={() => false}>
      <form onSubmit={submit} class="im-arrive w-full max-w-[440px] rounded-lg border border-line-1 bg-card px-7 pb-7 pt-6">
        <p class="text-sm text-ink-3">Step 1 of 4</p>
        <h1 class="mt-1.5 text-2xl font-semibold tracking-[-0.02em]">Sign in to your Ingle</h1>
        <p class="mt-2 text-base leading-5 text-ink-2">
          This instance belongs to one owner. Paste the owner token from your deploy output to unlock it.
        </p>

        <label class="mt-6 flex flex-col gap-2">
          <span class="text-sm font-medium text-ink-2">Owner token</span>
          <div
            class={INPUT_BOX}
            classList={{ "im-reject border-failed": error() !== undefined, "border-line-2": error() === undefined }}
          >
            <KeyRound size={14} stroke-width={1.75} class="shrink-0 text-icon" aria-hidden="true" />
            <input
              type={revealed() ? "text" : "password"}
              value={value()}
              onInput={(event) => {
                setValue(event.currentTarget.value)
                if (error() !== undefined) setError(undefined)
              }}
              autocomplete="current-password"
              spellcheck={false}
              autofocus
              placeholder="Paste the owner token"
              aria-invalid={error() !== undefined}
              aria-describedby="signin-note"
              disabled={busy()}
              class="h-full min-w-0 flex-1 bg-transparent font-mono text-base text-ink placeholder:font-sans placeholder:text-placeholder focus:outline-none disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => setRevealed((shown) => !shown)}
              aria-label={revealed() ? "Hide the token" : "Show the token"}
              aria-pressed={revealed()}
              class="im-press grid h-6 w-6 shrink-0 place-items-center rounded-sm text-icon hover:text-ink-2"
            >
              <Show when={revealed()} fallback={<Eye size={14} stroke-width={1.75} aria-hidden="true" />}>
                <EyeOff size={14} stroke-width={1.75} aria-hidden="true" />
              </Show>
            </button>
          </div>
          <span
            id="signin-note"
            role={error() === undefined ? undefined : "alert"}
            class="text-sm"
            classList={{ "text-failed": error() !== undefined, "text-ink-3": error() === undefined }}
          >
            {error() ?? "The token stays in this browser. You can rotate it later in Settings → Profile + token."}
          </span>
        </label>

        <div class="mt-5">
          <PrimaryButton type="submit" wide label={busy() ? "Checking" : "Continue"} busy={busy()} disabled={value().trim() === ""} />
        </div>

        <p class="mt-5 text-center text-sm text-ink-3">
          Lost the token? Run <code class="font-mono text-ink-2">wrangler secret put OWNER_TOKEN</code> and redeploy.
        </p>
      </form>
    </OnboardingFrame>
  )
}
