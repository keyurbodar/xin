import type { ConversationId } from "@earendil-works/pi-durable"
import type { FileEntry } from "./files.ts"

export const DRIVE_SCOPE_ID = "^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,159}$"

/** A Drive scope. A project is named by its id; a Captain or an automation by the id its own row gives it. */
export type DriveScope =
  | { readonly kind: "user" }
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "captain"; readonly id: string }
  | { readonly kind: "automation"; readonly id: string }

/** Names the Captain or automation scopes a conversation belongs to. The drive resolves user and project itself. */
export type DriveScopeSource = (
  conversationId: ConversationId,
) => readonly DriveScope[] | Promise<readonly DriveScope[]>

/** A reserved file's text: `skills/<name>/SKILL.md`, with the scope it came from. */
export type DriveSkillFile = {
  readonly scope: DriveScope
  readonly name: string
  readonly markdown: string
}

export interface DriveService {
  /** Adds a source of Captain or automation scopes; the returned function removes it. */
  attach(source: DriveScopeSource): () => void
  /** Installed skills, widest scope first, so a later one with the same name wins. Without a conversation, the user scope's. */
  skills(conversationId?: ConversationId): Promise<readonly DriveSkillFile[]>
  write(scope: DriveScope, path: string, text: string): Promise<FileEntry>
  remove(scope: DriveScope, path: string): Promise<boolean>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    drive: DriveService
  }
}
