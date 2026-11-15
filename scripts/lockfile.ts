/** The SRI `bun.lock` records for a package it resolves from a registry, if any. */
export function lockedIntegrity(lock: string, name: string): string | undefined {
  const parsed: unknown = JSON.parse(lock.replace(/,(\s*[}\]])/g, "$1"))
  const packages = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "packages") : undefined
  const entry: unknown = typeof packages === "object" && packages !== null ? Reflect.get(packages, name) : undefined
  const sri: unknown = Array.isArray(entry) ? entry[3] : undefined
  return typeof sri === "string" ? sri : undefined
}

/** Why the lockfile may not stand for `spec`: it resolves the package to bytes other than the ones the owner consented to. */
export function integrityProblem(spec: string, expected: string, lock: string): string | undefined {
  const name = spec.replace(/@[^@/]+$/, "")
  const actual = lockedIntegrity(lock, name)
  return actual === expected
    ? undefined
    : `${spec}: the lockfile resolves ${actual ?? "no registry tarball"}, the owner consented to ${expected}`
}
