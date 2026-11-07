const REF_BODY = "[A-Za-z0-9][A-Za-z0-9._-]*"
const TOKEN = new RegExp(`\\$\\{credential:(${REF_BODY})\\}`, "g")
const TOKEN_EXACT = new RegExp(`^\\$\\{credential:${REF_BODY}\\}$`)
const SUSPECT = /\$\{[^}]*\}/g

const WAITING_CREDENTIALS = "waiting-credentials"

export type SecretsPort = { get(ref: string): string | undefined }

export type Expanded =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "missing"; readonly refs: readonly string[] }

export type ExpandedAll =
  | { readonly kind: "ok"; readonly texts: readonly (string | undefined)[] }
  | { readonly kind: "missing"; readonly refs: readonly string[] }

export function credentialRefsIn(text: string): readonly string[] {
  return [...text.matchAll(TOKEN)].flatMap((token) => (token[1] === undefined ? [] : [token[1]]))
}

export function assertTemplateSyntax(text: string, where: string): void {
  for (const occurrence of text.matchAll(SUSPECT))
    if (!TOKEN_EXACT.test(occurrence[0]))
      throw new Error(`${where}: "${occurrence[0]}" is not a credential template; use \${credential:REF}`)
}

export function expandCredentials(text: string, secrets: SecretsPort): Expanded {
  assertTemplateSyntax(text, "credential template")
  const missing: string[] = []
  let expanded = ""
  let cursor = 0
  for (const token of text.matchAll(TOKEN)) {
    const ref = token[1]
    if (ref === undefined) continue
    const index = token.index ?? 0
    expanded += text.slice(cursor, index)
    const value = secrets.get(ref)
    if (value === undefined || value === "") {
      if (!missing.includes(ref)) missing.push(ref)
    } else expanded += value
    cursor = index + token[0].length
  }
  if (missing.length > 0) return { kind: "missing", refs: missing }
  return { kind: "ok", text: expanded + text.slice(cursor) }
}

export function expandAll(texts: readonly (string | undefined)[], secrets: SecretsPort): ExpandedAll {
  const missing: string[] = []
  const expanded: (string | undefined)[] = []
  for (const text of texts) {
    if (text === undefined) {
      expanded.push(undefined)
      continue
    }
    const result = expandCredentials(text, secrets)
    if (result.kind === "ok") expanded.push(result.text)
    else for (const ref of result.refs) if (!missing.includes(ref)) missing.push(ref)
  }
  return missing.length > 0 ? { kind: "missing", refs: missing } : { kind: "ok", texts: expanded }
}

export const waitingCredentials = (refs: readonly string[]): string => `${WAITING_CREDENTIALS} (${refs.join(", ")})`
