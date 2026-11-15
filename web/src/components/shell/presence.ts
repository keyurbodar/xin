import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"

export type Presence = {
  readonly mounted: Accessor<boolean>
  readonly leaving: Accessor<boolean>
}

/** Keeps an overlay mounted through its exit animation, then removes it. */
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
    }, exit)
  })

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  return { mounted, leaving }
}
