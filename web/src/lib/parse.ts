/** The one set of readers every op result and socket frame goes through. */

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined
}

export function strOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function stringsOf(value: unknown): readonly string[] {
  return listOf(value).filter((entry): entry is string => typeof entry === "string")
}
