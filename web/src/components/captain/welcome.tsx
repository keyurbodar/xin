import { createSignal, For, Show, type JSX } from "solid-js"
import { suggestionsFor } from "../../lib/onboarding.ts"
import type { CaptainProfile } from "../../lib/captains.ts"
import { CaptainAvatar } from "./avatar.tsx"

/** A new Captain's empty chat: who it is, what it is for, and starters that send as the owner's first message. */
export function CaptainWelcome(props: { captain: CaptainProfile; onStart: (text: string) => Promise<void> }): JSX.Element {
  const [sending, setSending] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const start = async (text: string): Promise<void> => {
    if (sending()) return
    setSending(true)
    setFailure(undefined)
    try {
      await props.onStart(text)
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : "The message did not reach the Captain.")
    } finally {
      setSending(false)
    }
  }
  return (
    <section aria-label={`Start with ${props.captain.name}`} class="im-arrive flex flex-col items-center gap-5 py-16 text-center">
      <CaptainAvatar name={props.captain.name} size={56} />
      <div class="flex flex-col gap-1.5">
        <h2 class="text-title-sm font-title text-ink">{props.captain.name}</h2>
        <p class="max-w-[420px] text-base leading-[1.6] text-ink-3">
          {props.captain.description === ""
            ? "Tell it what you want done. It starts crew threads for the work and reports back here."
            : props.captain.description}
        </p>
      </div>
      <div class="im-stagger grid w-full max-w-[520px] grid-cols-1 gap-2 sm:grid-cols-2">
        <For each={suggestionsFor(props.captain.description)}>
          {(suggestion, index) => (
            <button
              type="button"
              style={{ "--i": String(index()) }}
              disabled={sending()}
              onClick={() => void start(suggestion.title)}
              class="im-press flex flex-col items-start rounded-md text-left border border-line-1 bg-card px-3 py-2.5 transition-colors duration-150 hover:bg-hover disabled:opacity-60"
            >
              <span class="text-base text-ink">{suggestion.title}</span>
              <span class="text-sm text-ink-3">{suggestion.detail}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={failure()}>{(text) => <p class="text-sm text-failed">{text()}</p>}</Show>
    </section>
  )
}
