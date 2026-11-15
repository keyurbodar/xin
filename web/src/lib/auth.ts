const TOKEN_KEY = "xin.token"

export function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}

export function setToken(value: string): void {
  try {
    if (value === "") localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, value)
  } catch {
    /* a private window can refuse storage; the session then lives in memory only */
  }
}

export type Probe =
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "boot_failed"; readonly failure: string }
  | { readonly kind: "unreachable" }

/** A home that cannot open answers 503 with its failure for every token, so that answer says nothing about the token. */
export async function probe(value: string): Promise<Probe> {
  const response = await fetch("/v1/status", {
    headers: { authorization: `Bearer ${value}` },
  }).catch(() => undefined)
  if (response === undefined) return { kind: "unreachable" }
  if (response.ok) return { kind: "ok" }
  if (response.status === 401) return { kind: "unauthorized" }
  const body: unknown = await response.json().catch(() => undefined)
  const failure = typeof body === "object" && body !== null ? Reflect.get(body, "failure") : undefined
  if (response.status === 503 && typeof failure === "string") return { kind: "boot_failed", failure }
  return { kind: "unreachable" }
}
