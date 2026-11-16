import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import { keyStarted } from "../../lib/motion.ts"

export type Presence = {
  readonly mounted: Accessor<boolean>
  readonly leaving: Accessor<boolean>
}

/** Keeps an overlay mounted through its exit animation, then removes it; a keyboard close removes it at once. */
export function createPresence(open: Accessor<boolean>, exit: number): Presence {
  const [mounted, setMounted] = createSignal(open())
  const [leaving, setLeaving] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    if (open()) {
      if (timer !== undefined) clearTimeout(timer)
      setLeaving(false)
      setMounted(true)
      return
    }
    if (!untrack(mounted)) return
    setLeaving(true)
    timer = setTimeout(() => {
      setMounted(false)
      setLeaving(false)
    }, keyStarted() ? 0 : exit)
  })

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  return { mounted, leaving }
}

/** Keeps a ui-sdk overlay's children mounted while it is open and through its exit animation, which `settle` ends. */
export function createOverlayMount(open: Accessor<boolean>): {
  readonly mounted: Accessor<boolean>
  readonly settle: (event: CustomEvent<{ readonly value: boolean }>) => void
} {
  const [mounted, setMounted] = createSignal(open())
  createEffect(() => {
    if (open()) setMounted(true)
  })
  return {
    mounted,
    settle: (event) => {
      if (!event.detail.value && !untrack(open)) setMounted(false)
    },
  }
}
