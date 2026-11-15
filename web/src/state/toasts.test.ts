import { expect, test } from "bun:test"
import { TOAST_EXIT_MS, TOAST_LIMIT, dismissToast, liveToasts, showUndoToast, toasts, undoToast } from "./toasts.ts"

const icon = () => null

function counted(title: string) {
  const calls = { undo: 0, expire: 0 }
  showUndoToast({ icon, title, detail: undefined, undo: () => calls.undo++, expire: () => calls.expire++ })
  return calls
}

const newest = () => {
  const toast = liveToasts()[0]
  if (toast === undefined) throw new Error("no toast")
  return toast
}

test("an undone toast undoes once, never expires, and leaves the list after its exit", async () => {
  const calls = counted("Closed tab")
  const toast = newest()
  undoToast(toast)
  undoToast(toast)
  dismissToast(toast)
  expect(calls).toEqual({ undo: 1, expire: 0 })
  expect(liveToasts()).toEqual([])
  expect(toasts().map((entry) => entry.id)).toEqual([toast.id])
  await Bun.sleep(TOAST_EXIT_MS + 20)
  expect(toasts()).toEqual([])
})

test("a dismissed toast expires once, however often its end fires, and can no longer be undone", async () => {
  const calls = counted("Closed tab")
  const toast = newest()
  dismissToast(toast)
  dismissToast(toast)
  undoToast(toast)
  expect(calls).toEqual({ undo: 0, expire: 1 })
  await Bun.sleep(TOAST_EXIT_MS + 20)
  expect(toasts()).toEqual([])
})

test("the stack keeps three toasts, newest first, and the evicted one expires", async () => {
  const first = counted("a")
  for (const title of ["b", "c", "d"]) counted(title)
  expect(liveToasts().map((toast) => toast.title)).toEqual(["d", "c", "b"])
  expect(liveToasts()).toHaveLength(TOAST_LIMIT)
  expect(first).toEqual({ undo: 0, expire: 1 })
  for (const toast of liveToasts()) dismissToast(toast)
  await Bun.sleep(TOAST_EXIT_MS + 20)
  expect(toasts()).toEqual([])
})

test("a toast already dismissed does not expire again when a newer toast evicts it", async () => {
  const first = counted("a")
  dismissToast(newest())
  for (const title of ["b", "c", "d"]) counted(title)
  expect(first).toEqual({ undo: 0, expire: 1 })
  for (const toast of liveToasts()) dismissToast(toast)
  await Bun.sleep(TOAST_EXIT_MS + 20)
  expect(toasts()).toEqual([])
})
