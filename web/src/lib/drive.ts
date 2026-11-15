import { cmd, isDefinitive, OpError } from "./api.ts"

export type DriveScope =
  | { readonly kind: "user" }
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "captain"; readonly id: string }
  | { readonly kind: "automation"; readonly id: string }

export type MountedScope = { readonly scope: DriveScope; readonly root: string; readonly label: string }

export type DriveEntry = {
  readonly path: string
  readonly size: number
  readonly type: string
  readonly sha256: string
  readonly updated_at: number
}

export type DriveListing = {
  readonly root: string
  readonly files: readonly DriveEntry[]
  readonly shares: Readonly<Record<string, string>>
}

export type DriveFile = DriveEntry & { readonly text: string | null }

export type DriveVersion = { readonly sha256: string; readonly size: number; readonly type: string; readonly at: number }

export type DriveHistory = { readonly path: string; readonly current: DriveVersion; readonly versions: readonly DriveVersion[] }

export const INSTRUCTIONS_FILE = "AGENTS.md"
export const SKILLS_FOLDER = "skills"
export const INSTRUCTIONS_CAP = 20_000
const SKILL_FILE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/u

export type Reserved = { readonly kind: "instructions" } | { readonly kind: "skill"; readonly name: string }

/** The two paths every scope reserves: AGENTS.md at its root and skills/<name>/SKILL.md. */
export function reservedOf(path: string): Reserved | undefined {
  if (path === INSTRUCTIONS_FILE) return { kind: "instructions" }
  const name = SKILL_FILE.exec(path)?.[1]
  return name === undefined ? undefined : { kind: "skill", name }
}

export type DriveRow =
  | { readonly kind: "folder"; readonly name: string; readonly path: string; readonly files: number }
  | { readonly kind: "file"; readonly name: string; readonly entry: DriveEntry }

/** One folder's children from a listing of everything under it: subfolders first with their file counts, then files, each by name. */
export function rowsOf(files: readonly DriveEntry[], folder: string): readonly DriveRow[] {
  const folders = new Map<string, number>()
  const leaves: DriveRow[] = []
  for (const entry of files) {
    if (!entry.path.startsWith(folder)) continue
    const rest = entry.path.slice(folder.length)
    const cut = rest.indexOf("/")
    if (cut === -1) leaves.push({ kind: "file", name: rest, entry })
    else folders.set(rest.slice(0, cut), (folders.get(rest.slice(0, cut)) ?? 0) + 1)
  }
  const dirs = [...folders].map(([name, count]): DriveRow => ({ kind: "folder", name, path: `${folder}${name}/`, files: count }))
  return [...dirs.toSorted((a, b) => a.name.localeCompare(b.name)), ...leaves.toSorted((a, b) => a.name.localeCompare(b.name))]
}

export function crumbsOf(folder: string): readonly { readonly name: string; readonly path: string }[] {
  const parts = folder.split("/").filter((part) => part !== "")
  return parts.map((name, index) => ({ name, path: `${parts.slice(0, index + 1).join("/")}/` }))
}

export function folderOf(path: string): string {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? "" : path.slice(0, cut + 1)
}

export function scopeTitle(scope: DriveScope): string {
  switch (scope.kind) {
    case "user":
      return "Personal"
    case "project":
      return "Project"
    case "captain":
      return "Captain"
    case "automation":
      return "Automation"
    default: {
      const _exhaustive: never = scope
      return _exhaustive
    }
  }
}

function sameScope(left: DriveScope, right: DriveScope): boolean {
  return left.kind === right.kind && (left.kind === "user" || ("id" in right && left.id === right.id))
}

/** The scope the view shows: the one the person picked while the conversation still sees it, else the pane's own, else its project, else the widest. */
export function pickScope(
  scopes: readonly MountedScope[],
  picked: string | undefined,
  prefer: DriveScope,
): MountedScope | undefined {
  return (
    scopes.find((mounted) => mounted.root === picked) ??
    scopes.find((mounted) => sameScope(mounted.scope, prefer)) ??
    scopes.find((mounted) => mounted.scope.kind === "project") ??
    scopes[0]
  )
}

/** A move destination as typed: trimmed, relative to the scope's root, and undefined when it names nothing or the file itself. */
export function moveTarget(input: string, from: string, sameRoot: boolean): string | undefined {
  const to = input.trim().replace(/^\/+/u, "")
  if (to === "" || to.endsWith("/")) return undefined
  return sameRoot && to === from ? undefined : to
}

/** Where an uploaded file lands: the open folder under the scope's root, keeping the file's own name. */
export function uploadPath(root: string, folder: string, name: string): string {
  return `${root}${folder}${name.replaceAll("/", "-")}`
}

/** A share link as the Worker serves it: `/s/<id>/<file name>` on the app's origin. */
export function shareUrl(origin: string, id: string, path: string): string {
  return `${origin}/s/${id}/${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`
}

/** What a failed Drive op says inline: the host's own words for a rejection, a retry hint when the Worker never answered. */
export function failureText(problem: unknown): string {
  if (problem instanceof OpError && problem.code === "http") return `${problem.message}. Try again; a retry lands once.`
  return problem instanceof Error ? problem.message : String(problem)
}

/**
 * One command id per op while its args stay the same and no ack has come back, so a retry after a lost answer lands once.
 * Any ack, success or rejection, retires the id: the host would replay it to a later attempt instead of running it.
 */
export function createRetryIds(mint: () => string = () => crypto.randomUUID()): {
  readonly idFor: (op: string, args: Record<string, unknown>) => string
  readonly settle: (op: string, problem?: unknown) => void
} {
  const pending = new Map<string, { readonly fingerprint: string; readonly id: string }>()
  return {
    idFor: (op, args) => {
      const fingerprint = JSON.stringify(args)
      const held = pending.get(op)
      if (held?.fingerprint === fingerprint) return held.id
      const id = mint()
      pending.set(op, { fingerprint, id })
      return id
    },
    settle: (op, problem) => {
      if (problem === undefined || isDefinitive(problem)) pending.delete(op)
    },
  }
}

const retry = createRetryIds()

async function change<T>(op: string, args: Record<string, unknown>): Promise<T> {
  try {
    const result = await cmd<T>(op, args, { id: retry.idFor(op, args) })
    retry.settle(op)
    return result
  } catch (problem) {
    retry.settle(op, problem)
    throw new Error(failureText(problem), { cause: problem })
  }
}

export const drive = {
  scopes: (conversationId: number) => cmd<readonly MountedScope[]>("drive.scopes", { conversationId }),
  list: (scope: DriveScope, prefix: string) =>
    cmd<DriveListing>("drive.list", prefix === "" ? { scope } : { scope, prefix }),
  read: (scope: DriveScope, path: string, sha256?: string) =>
    cmd<DriveFile>("drive.read", sha256 === undefined ? { scope, path } : { scope, path, sha256 }),
  write: (scope: DriveScope, path: string, text: string) => change<DriveEntry>("drive.write", { scope, path, text }),
  move: (scope: DriveScope, from: string, to: string, toScope: DriveScope) =>
    change<DriveEntry>("drive.move", { scope, from, to, toScope }),
  remove: (scope: DriveScope, path: string) => change<{ readonly deleted: boolean }>("drive.delete", { scope, path }),
  history: (scope: DriveScope, path: string) => cmd<DriveHistory>("drive.history", { scope, path }),
  checkout: (scope: DriveScope, path: string, sha256: string) => change<DriveEntry>("drive.checkout", { scope, path, sha256 }),
  share: (scope: DriveScope, path: string) => change<{ readonly id: string; readonly url: string }>("drive.share", { scope, path }),
  unshare: (scope: DriveScope, path: string) => change<{ readonly revoked: boolean }>("drive.unshare", { scope, path }),
}
