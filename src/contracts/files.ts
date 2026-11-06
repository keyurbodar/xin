import type { EnvTarget } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"

export type FileEntry = {
  readonly path: string
  readonly size: number
  readonly type: string
  readonly sha256: string
  readonly project: string | null
  readonly updated_at: number
}

export interface FilesService {
  env(target: EnvTarget): ExecutionEnv | undefined
  list(prefix?: string): Promise<FileEntry[]>
  read(path: string): Promise<string | undefined>
  stat(path: string): Promise<FileEntry | undefined>
  write(path: string, text: string): Promise<FileEntry>
  remove(path: string): Promise<boolean>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    files: FilesService
  }
}
