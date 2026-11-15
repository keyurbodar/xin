import { createSignal, type JSX } from "solid-js"
import type { LucideProps } from "lucide-solid"

export type Toast = {
  readonly id: number
  readonly icon: (props: LucideProps) => JSX.Element
  readonly title: string
  readonly detail: string | undefined
  readonly undo: () => void
  readonly expire: () => void
}

export const TOAST_LIMIT = 3
export const TOAST_EXIT_MS = 160

const [list, setList] = createSignal<readonly Toast[]>([])
const [leaving, setLeaving] = createSignal<ReadonlySet<number>>(new Set())
const [heights, setHeights] = createSignal<ReadonlyMap<number, number>>(new Map())
let nextId = 0

export const toasts = list
export const toastHeights = heights

export const leavingToast = (id: number): boolean => leaving().has(id)

/** Toasts still on their way in or resting, newest first; a leaving toast is out of the stack at once. */
export const liveToasts = (): readonly Toast[] => list().filter((toast) => !leaving().has(toast.id))

/** Shows an undo toast, newest at the front; the oldest beyond the visible three expires without undo. */
export function showUndoToast(toast: Omit<Toast, "id">): void {
  const current = list()
  setList([{ ...toast, id: nextId++ }, ...current].slice(0, TOAST_LIMIT))
  const evicted = current.slice(TOAST_LIMIT - 1)
  setHeights((heights) => new Map([...heights].filter(([id]) => !evicted.some((toast) => toast.id === id))))
  for (const toast of evicted) if (!leaving().has(toast.id)) toast.expire()
}

export function setToastHeight(id: number, height: number): void {
  setHeights((current) => new Map([...current, [id, height]]))
}

/** Starts the exit and drops the toast once it has had time to play, whether or not a transition ran. */
function leave(toast: Toast): boolean {
  if (leaving().has(toast.id)) return false
  setLeaving((current) => new Set([...current, toast.id]))
  setTimeout(() => {
    setList((current) => current.filter((entry) => entry.id !== toast.id))
    setLeaving((current) => new Set([...current].filter((entry) => entry !== toast.id)))
    setHeights((current) => new Map([...current].filter(([entry]) => entry !== toast.id)))
  }, TOAST_EXIT_MS)
  return true
}

/** Ends a toast's undo window. */
export function dismissToast(toast: Toast): void {
  if (leave(toast)) toast.expire()
}

export function undoToast(toast: Toast): void {
  if (leave(toast)) toast.undo()
}
