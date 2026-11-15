import { createSignal } from "solid-js"

type PendingDraft = { readonly conversation: number; readonly text: string }

const [pending, setPending] = createSignal<PendingDraft | undefined>()

/** Hand a message to one conversation's composer, e.g. "Ask about this file". */
export function setPendingDraft(conversation: number, text: string): void {
  setPending({ conversation, text })
}

export function pendingDraftFor(conversation: number): string | undefined {
  const draft = pending()
  return draft?.conversation === conversation ? draft.text : undefined
}

export function takePendingDraft(conversation: number): string | undefined {
  const text = pendingDraftFor(conversation)
  if (text !== undefined) setPending(undefined)
  return text
}
