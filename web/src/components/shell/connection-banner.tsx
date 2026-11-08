import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { connectionState } from "../../state/connection.ts"

const GRACE_MS = 1500

/** X1: the socket is the app's only live channel. A short drop is a reconnect, not news. */
export function ConnectionBanner(): JSX.Element {
  const [late, setLate] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    const state = connectionState()
    clearTimeout(timer)
    if (state !== "closed") {
      setLate(false)
      return
    }
    timer = setTimeout(() => setLate(true), GRACE_MS)
  })

  onCleanup(() => clearTimeout(timer))

  return (
    <Show when={late()}>
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-warn/25 bg-warn-bg px-4 text-[12.5px] text-warn">
        <span class="h-1.5 w-1.5 rounded-[4px] bg-warn" />
        Reconnecting to the home. What you see may be a moment behind.
      </div>
    </Show>
  )
}
