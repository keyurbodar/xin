import { compile, int, nullable, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema"
import { type BrowserBackend, type BrowserSession, type Machine, type RunResult, StartFailed } from "./backend.ts"

const API = "https://api.instabox.sh"
const TEMPLATE = "agent-browser"
const AGENT_BROWSER = "agent-browser@0.43.0"
const INSTALL = `command -v agent-browser >/dev/null 2>&1 || npm install -g ${AGENT_BROWSER}`
const INSTALL_SECONDS = 300
const EXEC_SECONDS = 60
const POLL = "25s"
const POLL_TIMEOUT_MS = 40_000
const CALL_TIMEOUT_MS = 30_000
const OPERATION_DEADLINE_MS = 180_000
const SLACK_MS = 15_000

const ErrorBody = obj(
  { error: obj({ code: str(), message: opt(str()), operationId: opt(nullable(str())) }, { open: true }) },
  { open: true },
)
const OperationBody = obj(
  {
    id: str(),
    machineId: str(),
    type: opt(str()),
    state: oneOf(["queued", "running", "succeeded", "failed"] as const),
    error: opt(nullable(obj({ code: opt(str()), message: opt(str()) }, { open: true }))),
  },
  { open: true },
)
const ExecBody = obj({ stdout: str(), stderr: str(), exitCode: int() }, { open: true })

const errorCheck = compile(ErrorBody)
const operationCheck = compile(OperationBody)
const execCheck = compile(ExecBody)

type Operation = Static<typeof OperationBody>

export class InstaboxError extends Error {
  override readonly name = "InstaboxError"

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly operationId: string | undefined,
  ) {
    super(`Instabox answered ${status} ${code}: ${message}`)
  }
}

export type InstaboxOptions = {
  readonly apiKey: string | undefined
  readonly vcpus: number
  readonly memMiB: number
}

type Request = {
  readonly method: "GET" | "POST" | "DELETE"
  readonly path: string
  readonly body?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

const parse = (text: string): unknown => {
  if (text === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const failure = (done: Operation): string =>
  `Instabox ${done.type ?? "operation"} failed: ${done.error?.code ?? "unknown"} ${done.error?.message ?? ""}`.trim()

const operation = (value: unknown): Operation => {
  if (!operationCheck.check(value)) throw new Error("Instabox answered an operation it could not describe")
  return value
}

export function instaboxBackend(options: InstaboxOptions): BrowserBackend {
  const call = async (request: Request, signal: AbortSignal): Promise<unknown> => {
    if (options.apiKey === undefined || options.apiKey === "")
      throw new Error("the Worker has no INSTABOX_API_KEY secret, so the browser cannot start")
    const response = await fetch(`${API}${request.path}`, {
      method: request.method,
      headers: {
        "x-api-key": options.apiKey,
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
    })
    const value = parse(await response.text())
    if (response.ok) return value
    if (errorCheck.check(value))
      throw new InstaboxError(
        response.status,
        value.error.code,
        value.error.message ?? "",
        value.error.operationId ?? undefined,
      )
    throw new InstaboxError(response.status, "unknown", `HTTP ${response.status}`, undefined)
  }

  const settle = async (id: string, signal: AbortSignal): Promise<Operation> => {
    const deadline = Date.now() + OPERATION_DEADLINE_MS
    for (;;) {
      const current = operation(
        await call({ method: "GET", path: `/v1/operations/${id}?wait=${POLL}`, timeoutMs: POLL_TIMEOUT_MS }, signal),
      )
      if (current.state === "succeeded" || current.state === "failed") return current
      if (Date.now() > deadline) throw new Error(`Instabox operation ${id} did not finish in time`)
    }
  }

  const lifecycle = async (request: Request, key: string, signal: AbortSignal): Promise<Operation> => {
    const send = async (attempt: string): Promise<Operation> => {
      const accepted = operation(
        await call({ ...request, headers: { ...request.headers, "idempotency-key": attempt } }, signal),
      )
      return accepted.state === "succeeded" || accepted.state === "failed" ? accepted : settle(accepted.id, signal)
    }
    try {
      return await send(key)
    } catch (error) {
      if (!(error instanceof InstaboxError) || error.code !== "operation_conflict" || error.operationId === undefined)
        throw error
      await settle(error.operationId, signal)
      return send(`${key}:${error.operationId}`)
    }
  }

  const exec = async (
    machine: Machine,
    command: { readonly argv: readonly string[] } | { readonly cmd: string },
    seconds: number,
    signal: AbortSignal,
  ): Promise<RunResult> => {
    const value = await call(
      {
        method: "POST",
        path: `/v1/machines/${machine.id}/exec`,
        body: { ...command, timeoutSeconds: seconds },
        timeoutMs: seconds * 1_000 + SLACK_MS,
      },
      signal,
    )
    if (!execCheck.check(value)) throw new Error("Instabox answered a command result it could not describe")
    return { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode }
  }

  const boot = async (session: BrowserSession, signal: AbortSignal): Promise<Machine> => {
    const created = await lifecycle(
      {
        method: "POST",
        path: "/v1/machines",
        body: { templateId: TEMPLATE, vcpus: options.vcpus, memMiB: options.memMiB },
        timeoutMs: CALL_TIMEOUT_MS,
      },
      `${session.key}:create`,
      signal,
    )
    if (created.state === "failed") throw new StartFailed(failure(created))
    return { id: created.machineId, key: session.key }
  }

  return {
    start: boot,

    async prepare(machine, signal) {
      const installed = await exec(machine, { cmd: INSTALL }, INSTALL_SECONDS, signal)
      if (installed.exitCode !== 0)
        throw new Error(`installing agent-browser failed: ${(installed.stderr || installed.stdout).trim().slice(-500)}`)
    },

    run: (machine, argv, signal) => exec(machine, { argv }, EXEC_SECONDS, signal),

    async close(machine, signal) {
      try {
        const deleted = await lifecycle(
          {
            method: "DELETE",
            path: `/v1/machines/${machine.id}`,
            headers: { "x-confirm-delete": machine.id },
            timeoutMs: CALL_TIMEOUT_MS,
          },
          `${machine.key}:delete`,
          signal,
        )
        if (deleted.state === "failed") throw new Error(failure(deleted))
      } catch (error) {
        if (!(error instanceof InstaboxError && error.code === "not_found")) throw error
      }
    },
  }
}
