let pending: string | undefined

/** Hand a message to the composer on the next screen, e.g. "Ask about this file". */
export function setPendingDraft(text: string): void {
  pending = text
}

export function takePendingDraft(): string | undefined {
  const text = pending
  pending = undefined
  return text
}
