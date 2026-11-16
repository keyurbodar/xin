import type { Token, TokenCodec } from "@ui-sdk/web/token-input"

/** What a chip in the draft stands for. Each kind keeps the text the backend has always read for it. */
export type TokenKind = "thread" | "skill" | "file" | "prompt"

export type ComposerToken = { readonly kind: TokenKind; readonly value: string; readonly label: string }

const KINDS: readonly TokenKind[] = ["thread", "skill", "file", "prompt"]

const isTokenKind = (value: string): value is TokenKind => KINDS.some((kind) => kind === value)

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

export const toInputToken = (token: ComposerToken): Token => ({ type: token.kind, value: token.value, label: token.label })

export function fromInputToken(token: Token): ComposerToken | undefined {
  return isTokenKind(token.type) ? { kind: token.type, value: token.value, label: token.label } : undefined
}

/** Writes chips as backend text; reads any text back as plain text, so only a chip the owner picks is ever a chip. */
export const composerCodec: TokenCodec = {
  format: (token) => {
    const known = fromInputToken(token)
    return known === undefined ? token.label : formatToken(known)
  },
  parse: (text) => [text],
}
