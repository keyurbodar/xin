const GIT = /^(?:git\+|github:)/
const COMMIT = /^[0-9a-f]{40}$/

const parseLock = (lock: string): unknown => JSON.parse(lock.replace(/,(\s*[}\]])/g, "$1"))

const at = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const lockedEntry = (parsed: unknown, name: string): unknown => at(at(parsed, "packages"), name)

/** The SRI `bun.lock` records for a package it resolves from a registry, if any. */
export function lockedIntegrity(lock: string, name: string): string | undefined {
  const entry = lockedEntry(parseLock(lock), name)
  const sri: unknown = Array.isArray(entry) ? entry[3] : undefined
  return typeof sri === "string" ? sri : undefined
}

export const nameOf = (spec: string): string => spec.replace(/@[^@/]+$/, "")

const commitOf = (spec: string): string => spec.split("#")[1]?.split("&")[0] ?? ""

export const isGitSpec = (spec: string): boolean => GIT.test(spec)

/** Why sync may not build a spec, checked before anything is fetched: a git spec must pin a commit, and a registry name must not be one the build ships. */
export function specProblem(spec: string, shipped: ReadonlySet<string>): string | undefined {
  if (isGitSpec(spec))
    return COMMIT.test(commitOf(spec))
      ? undefined
      : `${spec}: name a 40-hex commit, not a branch or tag, so the build installs what the owner consented to`
  return shipped.has(nameOf(spec))
    ? `${spec}: ${nameOf(spec)} ships with this build, so a market package may not replace it`
    : undefined
}

/** Why a built git spec may not stand: it named a package the build ships, or bun built another commit than the pin. */
export function gitProblem(spec: string, lock: string, shipped: ReadonlySet<string>): string | undefined {
  const parsed = parseLock(lock)
  const dependencies = at(at(at(parsed, "workspaces"), ""), "dependencies")
  const name = Object.entries(typeof dependencies === "object" && dependencies !== null ? dependencies : {}).find(
    ([, value]) => value === spec,
  )?.[0]
  if (name === undefined) return `${spec}: the lockfile has no dependency for it`
  if (shipped.has(name))
    return `${spec} builds ${name}, which ships with this build, so a market package may not replace it`
  const entry = lockedEntry(parsed, name)
  const id: unknown = Array.isArray(entry) ? entry[0] : undefined
  const built = typeof id === "string" && id.includes("#") ? id.slice(id.lastIndexOf("#") + 1) : ""
  const commit = commitOf(spec)
  return built.length >= 7 && commit.startsWith(built)
    ? undefined
    : `${spec}: the build resolved ${built === "" ? "no commit" : built}, the owner pinned ${commit}`
}

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
