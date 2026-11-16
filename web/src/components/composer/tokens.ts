import type { Token, TokenCodec, TokenInputValue } from "@ui-sdk/web/token-input"

/** What a chip in the draft stands for. Each kind keeps the text the backend has always read for it. */
export type TokenKind = "thread" | "skill" | "file" | "prompt"

export type ComposerToken = { readonly kind: TokenKind; readonly value: string; readonly label: string }

const KINDS: readonly TokenKind[] = ["thread", "skill", "file", "prompt"]

export const isTokenKind = (value: string): value is TokenKind => KINDS.some((kind) => kind === value)

/** `@thread:12`, `@skill:issues`, `@/projects/x/notes.md`, `/fix`: the draft's chips written as plain text. */
export function formatToken(token: { readonly kind: TokenKind; readonly value: string }): string {
  switch (token.kind) {
    case "thread":
      return `@thread:${token.value}`
    case "skill":
      return `@skill:${token.value}`
    case "file":
      return `@${token.value}`
    case "prompt":
      return `/${token.value}`
    default: {
      const _exhaustive: never = token.kind
      return _exhaustive
    }
  }
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const PATTERN = /(@thread:\d+|@skill:[a-z0-9][a-z0-9-]*|@\/\S+|^\/[a-z][a-z0-9-]*(?=\s|$))/gu

function tokenOf(text: string): ComposerToken | undefined {
  if (text.startsWith("@thread:")) return { kind: "thread", value: text.slice(8), label: `Thread ${text.slice(8)}` }
  if (text.startsWith("@skill:")) return { kind: "skill", value: text.slice(7), label: text.slice(7) }
  if (text.startsWith("@/")) return { kind: "file", value: text.slice(1), label: baseName(text) }
  if (text.startsWith("/")) return { kind: "prompt", value: text.slice(1), label: text.slice(1) }
  return undefined
}

export const toInputToken = (token: ComposerToken): Token => ({ type: token.kind, value: token.value, label: token.label })

export function fromInputToken(token: Token): ComposerToken | undefined {
  return isTokenKind(token.type) ? { kind: token.type, value: token.value, label: token.label } : undefined
}

/** Reads draft text back into text and chips, so a pasted or restored draft keeps its chips. */
export function parseDraft(text: string): TokenInputValue {
  return text.split(PATTERN).flatMap((part): TokenInputValue => {
    if (part === "") return []
    const token = tokenOf(part)
    return token === undefined ? [part] : [toInputToken(token)]
  })
}

export const composerCodec: TokenCodec = {
  format: (token) => {
    const known = fromInputToken(token)
    return known === undefined ? token.label : formatToken(known)
  },
  parse: parseDraft,
}
