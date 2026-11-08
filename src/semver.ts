export function satisfies(version: string, range: string): boolean {
  const built = versionTuple(version)
  if (built === undefined) return false
  return range.split("||").some((alternative) => inAlternative(built, alternative.trim()))
}

type Tuple = readonly [number, number, number]

export function compareVersions(left: string, right: string): number {
  const a = versionTuple(left)
  const b = versionTuple(right)
  if (a === undefined || b === undefined) return left.localeCompare(right)
  const order = compare(a, b)
  return order === 0 ? comparePrerelease(prereleaseOf(left), prereleaseOf(right)) : order
}

export function isPrerelease(version: string): boolean {
  return prereleaseOf(version) !== undefined
}

function prereleaseOf(version: string): string | undefined {
  return /^\d+(?:\.\d+){0,2}-([0-9A-Za-z.-]+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version)?.[1]
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  const a = left.split(".")
  const b = right.split(".")
  for (let index = 0; ; index += 1) {
    const one = a[index]
    const two = b[index]
    if (one === undefined) return two === undefined ? 0 : -1
    if (two === undefined) return 1
    const order = compareIdentifier(one, two)
    if (order !== 0) return order
  }
}

function compareIdentifier(left: string, right: string): number {
  const a = /^\d+$/.test(left) ? Number(left) : undefined
  const b = /^\d+$/.test(right) ? Number(right) : undefined
  if (a !== undefined && b !== undefined) return a === b ? 0 : a < b ? -1 : 1
  if (a !== undefined) return -1
  if (b !== undefined) return 1
  return left === right ? 0 : left < right ? -1 : 1
}

function versionTuple(text: string): Tuple | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(text)
  const major = match?.[1]
  if (match === null || major === undefined) return undefined
  return [Number(major), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function inAlternative(version: Tuple, text: string): boolean {
  if (text === "" || text === "*" || text === "x" || text === "X") return true
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(text)
  const op = match?.[1] ?? ""
  const body = match?.[2]
  if (body === undefined) return false
  const parts = body.split(".")
  if (parts.length > 3) return false
  const major = parts[0]
  if (major === undefined) return false
  const tuple: Tuple = [Number(major), Number(parts[1] ?? "0"), Number(parts[2] ?? "0")]
  if (tuple.some((part) => Number.isNaN(part))) return false
  const atLeast = compare(version, tuple) >= 0
  switch (op) {
    case "^": {
      const upper: Tuple =
        tuple[0] > 0 || parts.length === 1
          ? [tuple[0] + 1, 0, 0]
          : tuple[1] > 0 || parts.length === 2
            ? [0, tuple[1] + 1, 0]
            : [0, 0, tuple[2] + 1]
      return atLeast && compare(version, upper) < 0
    }
    case "~": {
      const upper: Tuple = parts.length === 1 ? [tuple[0] + 1, 0, 0] : [tuple[0], tuple[1] + 1, 0]
      return atLeast && compare(version, upper) < 0
    }
    case ">=":
      return atLeast
    case ">":
      return compare(version, tuple) > 0
    case "<=":
      return !(compare(version, tuple) > 0)
    case "<":
      return compare(version, tuple) < 0
    default:
      return matchesPrefix(version, tuple, parts.length)
  }
}

function matchesPrefix(version: Tuple, tuple: Tuple, length: number): boolean {
  if (length === 1) return version[0] === tuple[0]
  if (length === 2) return version[0] === tuple[0] && version[1] === tuple[1]
  return compare(version, tuple) === 0
}

function compare(left: Tuple, right: Tuple): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}
