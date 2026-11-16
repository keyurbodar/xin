import { createSignal, type JSX } from "solid-js"
import type { LucideProps } from "lucide-solid"

export type Toast = {
  readonly id: number
  readonly icon: (props: LucideProps) => JSX.Element
  readonly title: string
  readonly detail: string | undefined
  /** Absent for a notice, which only informs and has nothing to take back. */
  readonly undo?: () => void
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

/**
 * Shows a toast, newest at the front, keeping at most three. A notice never takes an undo toast's place: room is made
 * by dropping the oldest notice, so with three undo toasts showing a new notice is dropped itself. An undo toast that is
 * pushed out by a newer undo toast expires, which ends its undo window.
 */
export function showToast(toast: Omit<Toast, "id">): void {
  const next = [{ ...toast, id: nextId++ }, ...list()]
  const evicted: Toast[] = []
  while (next.length > TOAST_LIMIT) {
    const notice = next.findLastIndex((entry) => entry.undo === undefined)
    evicted.push(...next.splice(notice === -1 ? next.length - 1 : notice, 1))
  }
  setList(next)
  setHeights((heights) => new Map([...heights].filter(([id]) => !evicted.some((entry) => entry.id === id))))
  for (const entry of evicted) if (!leaving().has(entry.id)) entry.expire()
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
  if (toast.undo !== undefined && leave(toast)) toast.undo()
}
