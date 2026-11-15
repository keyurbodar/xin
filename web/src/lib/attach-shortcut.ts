type Key = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key" | "preventDefault">

/** ⌘/ or Ctrl+/ opens the file picker, but only for the composer that is on screen. */
export function handleAttachShortcut(event: Key, active: boolean, pick: () => void): void {
  if (!active || !(event.metaKey || event.ctrlKey) || event.key !== "/") return
  event.preventDefault()
  pick()
}
