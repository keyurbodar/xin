import { expect, test } from "bun:test"
import { TOAST_EXIT_MS, TOAST_LIMIT, dismissToast, liveToasts, showUndoToast, toasts, undoToast } from "./toasts.ts"

const icon = () => null

test("an undone toast leaves the stack at once and the list after its exit, with no transition needed", async () => {
  let undone = 0
  showUndoToast({ icon, title: "Closed tab", detail: undefined, undo: () => undone++ })
  const toast = liveToasts()[0]
  if (toast === undefined) throw new Error("no toast")
  undoToast(toast)
  undoToast(toast)
  expect(undone).toBe(1)
  expect(liveToasts()).toEqual([])
  expect(toasts().map((entry) => entry.id)).toEqual([toast.id])
  await Bun.sleep(TOAST_EXIT_MS + 20)
  expect(toasts()).toEqual([])
})

test("the stack keeps only as many toasts as it shows, newest first", async () => {
  for (const title of ["a", "b", "c", "d"]) showUndoToast({ icon, title, detail: undefined, undo: () => undefined })
  expect(liveToasts().map((toast) => toast.title)).toEqual(["d", "c", "b"])
  expect(liveToasts()).toHaveLength(TOAST_LIMIT)
  for (const toast of liveToasts()) dismissToast(toast.id)
  await Bun.sleep(TOAST_EXIT_MS + 20)
  expect(toasts()).toEqual([])
})
