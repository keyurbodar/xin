import type { ConversationId, DocumentReader, EnvTarget } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"

export type FileEntry = {
  readonly path: string
  readonly size: number
  readonly type: string
  readonly sha256: string
  readonly updated_at: number
}

const TEXT_TYPE = /^(text\/|application\/(json|xml|.*\+json|.*\+xml)|image\/svg\+xml)/

/** A type whose bytes read as text: what `file.read` previews and what a turn may inline. */
export const isText = (type: string): boolean => TEXT_TYPE.test(type)

export type FileVersion = {
  readonly sha256: string
  readonly size: number
  readonly type: string
  readonly at: number
}

/** Lets a thread use a path outside its project folder. `/me` stays the coordinator's whatever a grant says. */
export type FileGrant = (target: {
  readonly conversationId: ConversationId
  readonly path: string
  readonly read: DocumentReader
}) => boolean | Promise<boolean>

export interface FilesService {
  env(target: EnvTarget): ExecutionEnv | undefined
  list(prefix?: string): Promise<FileEntry[]>
  read(path: string): Promise<string | undefined>
  readBytes(path: string): Promise<Uint8Array | undefined>
  /** The bytes stored under a content address, whatever path holds them now; one R2 read and no index row. */
  readBlob(sha256: string): Promise<Uint8Array | undefined>
  stat(path: string): Promise<FileEntry | undefined>
  /** With `base`, refused with StaleWrite unless the file's current sha is `base`. */
  write(path: string, text: string, base?: string): Promise<FileEntry>
  remove(path: string): Promise<boolean>
  /** Earlier versions, newest first. The current one is the file itself. */
  revisions(path: string): Promise<readonly FileVersion[]>
  /** Makes an earlier version current again; the replaced one becomes a version. Undefined when there is no such version. */
  restore(path: string, sha256: string): Promise<FileEntry | undefined>
  /** Moves a file with its versions. False when the source is missing or the destination exists. */
  move(from: string, to: string): Promise<boolean>
  /** Called with each changed path, or a prefix ending in `/`, after any write, move or delete through any route. */
  watch(listener: (path: string) => void | Promise<void>): () => void
  grant(rule: FileGrant): () => void
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    files: FilesService
  }
}
