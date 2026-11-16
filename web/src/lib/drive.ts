import { cmd, isDefinitive, MAX_UPLOAD_BYTES, OpError } from "./api.ts"
import { bytes } from "./format.ts"

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

const THUMBNAIL = /^image\/(png|jpe?g|gif|webp|avif)$/u

/** Whether a file shows its own picture as its thumbnail: the raster types every browser decodes. */
export function hasThumbnail(type: string): boolean {
  return THUMBNAIL.test(type)
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

/** Why a file can't take this name in its folder, or undefined when it can. Its own name is fine and renames nothing. */
export function renameProblem(name: string, current: string, siblings: readonly string[]): string | undefined {
  const trimmed = name.trim()
  if (trimmed === "") return "Give it a name."
  if (trimmed.includes("/") || trimmed.includes("\\")) return "A name can't hold a slash."
  if (trimmed === "." || trimmed === "..") return `${trimmed} is reserved.`
  const lower = trimmed.toLowerCase()
  const taken = siblings.find((sibling) => sibling !== current && sibling.toLowerCase() === lower)
  return taken === undefined ? undefined : `${taken} is already in this folder.`
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

export type CopyOutcome = "copied" | "manual"

/** Copies a share link, or says it must be copied by hand when the browser has no clipboard or refuses access. */
export async function copyLink(url: string, write: ((text: string) => Promise<void>) | undefined): Promise<CopyOutcome> {
  if (write === undefined) return "manual"
  try {
    await write(url)
    return "copied"
  } catch {
    return "manual"
  }
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

/** Why Save is held back, or undefined when the text can be written. AGENTS.md past the cap would be clipped when injected, so it is refused instead. */
export function saveBlock(path: string, text: string): string | undefined {
  if (reservedOf(path)?.kind !== "instructions" || text.length <= INSTRUCTIONS_CAP) return undefined
  return `AGENTS.md is ${text.length.toLocaleString("en")} characters; conversations read only the first ${INSTRUCTIONS_CAP.toLocaleString("en")}. Shorten it to save.`
}

/** The host's answer to a write whose `base` is no longer the file's current version. */
export function isStale(problem: unknown): boolean {
  const answer = problem instanceof Error && problem.cause !== undefined ? problem.cause : problem
  return answer instanceof OpError && answer.code === "bad_args" && answer.message.startsWith("stale base:")
}

export type ConflictChoice = "reload" | "overwrite"

export type DriveWrite = { readonly scope: DriveScope; readonly path: string; readonly text: string; readonly base?: string }

/** What Save sends: the draft, with the sha the file was opened at as `base` so a newer version is never replaced unseen. */
export function writeArgs(scope: DriveScope, path: string, text: string, opened: { readonly sha256: string } | undefined): DriveWrite {
  return opened === undefined ? { scope, path, text } : { scope, path, text, base: opened.sha256 }
}

/** After a stale write: Reload drops the edits and reads the file again; Overwrite sends them again over the version now current. */
export function resolveConflict(
  choice: ConflictChoice,
  stale: DriveWrite,
  current: { readonly sha256: string },
): { readonly kind: "reload" } | { readonly kind: "write"; readonly write: DriveWrite } {
  return choice === "reload" ? { kind: "reload" } : { kind: "write", write: { ...stale, base: current.sha256 } }
}

/** Files over the upload limit never leave the browser; the rest are sent. */
export function splitUploads<T extends { readonly name: string; readonly size: number }>(
  files: readonly T[],
  limit: number = MAX_UPLOAD_BYTES,
): { readonly send: readonly T[]; readonly tooBig: readonly T[] } {
  return { send: files.filter((file) => file.size <= limit), tooBig: files.filter((file) => file.size > limit) }
}

/** What a partly failed upload says, or undefined when every file landed. */
export function uploadSummary(tooBig: readonly string[], failed: readonly string[], limit: number = MAX_UPLOAD_BYTES): string | undefined {
  const parts = [
    ...(tooBig.length === 0 ? [] : [`Over ${bytes(limit)}, not sent: ${tooBig.join(", ")}.`]),
    ...(failed.length === 0 ? [] : [`Failed to upload: ${failed.join(", ")}.`]),
  ]
  return parts.length === 0 ? undefined : parts.join(" ")
}

export const drive = {
  scopes: (conversationId: number) => cmd<readonly MountedScope[]>("drive.scopes", { conversationId }),
  list: (scope: DriveScope, prefix: string) =>
    cmd<DriveListing>("drive.list", prefix === "" ? { scope } : { scope, prefix }),
  read: (scope: DriveScope, path: string, sha256?: string) =>
    cmd<DriveFile>("drive.read", sha256 === undefined ? { scope, path } : { scope, path, sha256 }),
  write: (args: DriveWrite) => change<DriveEntry>("drive.write", args),
  move: (scope: DriveScope, from: string, to: string, toScope: DriveScope) =>
    change<DriveEntry>("drive.move", { scope, from, to, toScope }),
  remove: (scope: DriveScope, path: string) => change<{ readonly deleted: boolean }>("drive.delete", { scope, path }),
  history: (scope: DriveScope, path: string) => cmd<DriveHistory>("drive.history", { scope, path }),
  checkout: (scope: DriveScope, path: string, sha256: string) => change<DriveEntry>("drive.checkout", { scope, path, sha256 }),
  share: (scope: DriveScope, path: string) => change<{ readonly id: string; readonly url: string }>("drive.share", { scope, path }),
  unshare: (scope: DriveScope, path: string) => change<{ readonly revoked: boolean }>("drive.unshare", { scope, path }),
}
