export type Machine = {
  readonly id: string
  readonly key: string
}

export type BrowserSession = {
  readonly key: string
}

export type RunResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface BrowserBackend {
  start(session: BrowserSession, signal: AbortSignal): Promise<Machine>
  prepare(machine: Machine, signal: AbortSignal): Promise<void>
  run(machine: Machine, argv: readonly string[], signal: AbortSignal): Promise<RunResult>
  close(machine: Machine, signal: AbortSignal): Promise<void>
}

export class StartFailed extends Error {
  override readonly name = "StartFailed"
}
