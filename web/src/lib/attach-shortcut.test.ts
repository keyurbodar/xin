import { expect, test } from "bun:test"
import { handleAttachShortcut } from "./attach-shortcut.ts"

const press = (key: string, ctrlKey = true) => {
  let prevented = false
  return { event: { key, ctrlKey, metaKey: false, preventDefault: () => (prevented = true) }, prevented: () => prevented }
}

test("only the composer on screen opens the file picker on Ctrl+/", () => {
  let picks = 0
  const hidden = press("/")
  handleAttachShortcut(hidden.event, false, () => picks++)
  expect(picks).toBe(0)
  expect(hidden.prevented()).toBe(false)
  const shown = press("/")
  handleAttachShortcut(shown.event, true, () => picks++)
  expect(picks).toBe(1)
  expect(shown.prevented()).toBe(true)
  handleAttachShortcut(press("/", false).event, true, () => picks++)
  handleAttachShortcut(press("k").event, true, () => picks++)
  expect(picks).toBe(1)
})
