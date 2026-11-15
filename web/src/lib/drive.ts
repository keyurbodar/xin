import { cmd } from "./api.ts"

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

export function reservedOf(path: string): Reserved | undefined {
  if (path === INSTRUCTIONS_FILE) return { kind: "instructions" }
  const name = SKILL_FILE.exec(path)?.[1]
  return name === undefined ? undefined : { kind: "skill", name }
}

export function shareUrl(id: string, path: string): string {
  return new URL(`/s/${id}/${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`, location.origin).href
}

export const drive = {
  scopes: (conversationId: number) => cmd<readonly MountedScope[]>("drive.scopes", { conversationId }),
  list: (scope: DriveScope, prefix: string) =>
    cmd<DriveListing>("drive.list", prefix === "" ? { scope } : { scope, prefix }),
  read: (scope: DriveScope, path: string, sha256?: string) =>
    cmd<DriveFile>("drive.read", sha256 === undefined ? { scope, path } : { scope, path, sha256 }),
  write: (scope: DriveScope, path: string, text: string) => cmd<DriveEntry>("drive.write", { scope, path, text }),
  move: (scope: DriveScope, from: string, to: string, toScope: DriveScope) =>
    cmd<DriveEntry>("drive.move", { scope, from, to, toScope }),
  remove: (scope: DriveScope, path: string) => cmd<{ readonly deleted: boolean }>("drive.delete", { scope, path }),
  history: (scope: DriveScope, path: string) => cmd<DriveHistory>("drive.history", { scope, path }),
  checkout: (scope: DriveScope, path: string, sha256: string) => cmd<DriveEntry>("drive.checkout", { scope, path, sha256 }),
  share: (scope: DriveScope, path: string) => cmd<{ readonly id: string; readonly url: string }>("drive.share", { scope, path }),
  unshare: (scope: DriveScope, path: string) => cmd<{ readonly revoked: boolean }>("drive.unshare", { scope, path }),
}
