import { createSignal, type JSX } from "solid-js"
import { setToken, verifyToken } from "../lib/auth.ts"

export function SignIn(props: { onSignedIn: () => void }): JSX.Element {
  const [value, setValue] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setError(undefined)
    const accepted = await verifyToken(value().trim())
    setBusy(false)
    if (!accepted) {
      setError("That token was not accepted.")
      return
    }
    setToken(value().trim())
    props.onSignedIn()
  }

  return (
    <div class="atmos grid h-full place-items-center px-6">
      <form onSubmit={submit} class="crosshair enter w-full max-w-[380px] border border-line bg-surface p-8">
        <div class="label">Owner access</div>
        <h1 class="mt-3 text-[28px] font-light leading-none tracking-[-0.03em]">Sign in</h1>
        <p class="mt-3 text-[12.5px] leading-relaxed text-fg-3">
          This home belongs to one owner. Paste the owner token from your deployment.
        </p>
        <label class="mt-6 block">
          <span class="label">Token</span>
          <input
            type="password"
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
            autocomplete="current-password"
            spellcheck={false}
            placeholder="owner token"
            class="mt-2 h-9 w-full rounded-[2px] border border-line-inner bg-page px-3 font-mono text-[12px] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none"
          />
        </label>
        <p class="mt-2 h-4 font-mono text-[10px] uppercase tracking-[0.08em] text-bad">{error() ?? ""}</p>
        <button
          type="submit"
          disabled={busy() || value().trim() === ""}
          class="mt-3 h-8 w-full rounded-[2px] bg-accent text-[12.5px] font-medium text-black transition-none hover:bg-accent disabled:opacity-40"
        >
          {busy() ? "Checking" : "Continue"}
        </button>
        <p class="mt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-4">
          The token stays in this browser
        </p>
      </form>
    </div>
  )
}
