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

export async function verifyToken(value: string): Promise<boolean> {
  if (value === "") return false
  const response = await fetch("/v1/status", {
    headers: { authorization: `Bearer ${value}` },
  }).catch(() => undefined)
  return response?.ok === true
}
