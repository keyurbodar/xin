/** The SRI `bun.lock` records for a package it resolves from a registry, if any. */
export function lockedIntegrity(lock: string, name: string): string | undefined {
  const parsed: unknown = JSON.parse(lock.replace(/,(\s*[}\]])/g, "$1"))
  const packages = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "packages") : undefined
  const entry: unknown = typeof packages === "object" && packages !== null ? Reflect.get(packages, name) : undefined
  const sri: unknown = Array.isArray(entry) ? entry[3] : undefined
  return typeof sri === "string" ? sri : undefined
}

export const nameOf = (spec: string): string => spec.replace(/@[^@/]+$/, "")

/** Why the lockfile may not stand for `spec`: it resolves the package to bytes other than the ones the owner consented to. */
export function integrityProblem(spec: string, expected: string, lock: string): string | undefined {
  const actual = lockedIntegrity(lock, nameOf(spec))
  return actual === expected
    ? undefined
    : `${spec}: the lockfile resolves ${actual ?? "no registry tarball"}, the owner consented to ${expected}`
}

/** The sha512 SRI of a tarball's bytes. */
export async function sha512Of(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes))
  return `sha512-${btoa(String.fromCharCode(...digest))}`
}

/** Why the tarball the build fetched may not be installed: its bytes are not the ones the owner consented to. */
export async function tarballProblem(spec: string, expected: string, bytes: Uint8Array): Promise<string | undefined> {
  const actual = await sha512Of(bytes)
  return actual === expected
    ? undefined
    : `${spec}: the tarball hashes to ${actual}, the owner consented to ${expected}`
}

/** Why the installed package may not mount: its package.json declares a permission the owner did not approve. */
export function permissionProblem(spec: string, approved: readonly string[], manifest: unknown): string | undefined {
  const ingle = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "ingle") : undefined
  const plugins = typeof ingle === "object" && ingle !== null ? Reflect.get(ingle, "plugins") : undefined
  const declared = Object.values(typeof plugins === "object" && plugins !== null ? plugins : {}).flatMap((entry) => {
    const permissions: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "permissions") : []
    return Array.isArray(permissions) ? permissions.map(String) : []
  })
  const extra = [...new Set(declared.filter((permission) => !approved.includes(permission)))].toSorted()
  return extra.length === 0
    ? undefined
    : `${spec}: the installed package declares ${extra.join(", ")}, which the owner did not approve`
}
