export type Note = {
  readonly id: number
  readonly scope: string
  readonly text: string
  readonly at: number
  readonly source?: string
  readonly pinned?: boolean
}

export type NoteDraft = {
  readonly text: string
  readonly scope: string
  readonly source: string
  readonly originTask: string
  readonly at: number
}

export interface MemoryService {
  remember(draft: NoteDraft): Promise<boolean>
  search(query: string, scopes: readonly string[], now: number, limit?: number): Promise<readonly Note[]>
  profile(): Promise<string>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    memory: MemoryService
  }
}
