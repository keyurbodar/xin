const API = "https://api.instabox.sh"

export type Spec = { readonly vcpus: number; readonly memMiB: number }
export type Machine = {
  readonly id: string
  readonly name: string
  readonly state: string
  readonly createdAt: string
  readonly metadata?: Record<string, string>
}
export type Exec = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}
type Operation = {
  readonly id: string
  readonly state: string
  readonly machineId?: string
  readonly snapshotId?: string
  readonly snapshot?: { readonly id: string }
  readonly error?: { readonly code?: string; readonly message?: string } | null
}
type Failure = { code?: string; message?: string; retryable?: boolean; retryAfterSeconds?: number }

export class InstaboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(`instabox ${status} ${code}: ${detail}`)
  }
}

export function instabox(key: string) {
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { "X-API-Key": key, "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).catch(() => undefined)
      if (response?.ok) return (response.status === 204 ? undefined : await response.json()) as T
      const failure: Failure = response
        ? (((await response.json().catch(() => ({}))) as { error?: Failure }).error ?? {})
        : { code: "network", retryable: true }
      const retryable = failure.retryable === true || response === undefined || response.status >= 500
      if (!retryable || attempt >= 5)
        throw new InstaboxError(response?.status ?? 0, failure.code ?? "unknown", failure.message ?? path)
      await Bun.sleep(Math.min(60, failure.retryAfterSeconds ?? 2 ** attempt) * 1000)
    }
  }

  const change = (method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    call<Operation>(method, path, body, { "Idempotency-Key": crypto.randomUUID(), ...headers })

  async function settle(first: Operation): Promise<Operation> {
    let op = first
    while (op.state !== "succeeded") {
      if (op.state === "failed")
        throw new InstaboxError(0, op.error?.code ?? "operation_failed", op.error?.message ?? op.id)
      op = await call<Operation>("GET", `/v1/operations/${op.id}?wait=25s`)
    }
    return op
  }

  return {
    async create(options: {
      readonly name: string
      readonly source: { readonly snapshotId: string } | { readonly templateId: string }
      readonly spec: Spec
      readonly metadata: Record<string, string>
      readonly deleteAfterSeconds: number
      readonly autoSuspendAfterSeconds?: number
      readonly envSecrets?: readonly string[]
    }): Promise<string> {
      const op = await settle(
        await change("POST", "/v1/machines", {
          name: options.name,
          ...options.source,
          vcpus: options.spec.vcpus,
          memMiB: options.spec.memMiB,
          metadata: options.metadata,
          deleteAfterSeconds: options.deleteAfterSeconds,
          autoSuspendAfterSeconds: options.autoSuspendAfterSeconds ?? 1800,
          secrets: [],
          envSecrets: options.envSecrets ?? [],
          vault: false,
        }),
      )
      if (op.machineId === undefined) throw new InstaboxError(0, "no_machine_id", options.name)
      return op.machineId
    },
    async remove(id: string): Promise<void> {
      try {
        const op = await call<Operation | undefined>("DELETE", `/v1/machines/${id}`, undefined, {
          "Idempotency-Key": crypto.randomUUID(),
          "X-Confirm-Delete": id,
        })
        if (op?.id !== undefined) await settle(op)
      } catch (error) {
        if (!(error instanceof InstaboxError && error.status === 404)) throw error
      }
    },
    stop: async (id: string) => void (await settle(await change("POST", `/v1/machines/${id}/stop`))),
    start: async (id: string) => void (await settle(await change("POST", `/v1/machines/${id}/start`))),
    resume: async (id: string) => void (await settle(await change("POST", `/v1/machines/${id}/resume`))),
    async list(): Promise<readonly Machine[]> {
      const machines: Machine[] = []
      let cursor: string | null = null
      do {
        const page: { machines: Machine[]; nextCursor: string | null } = await call(
          "GET",
          `/v1/machines${cursor === null ? "" : `?cursor=${cursor}`}`,
        )
        machines.push(...page.machines)
        cursor = page.nextCursor
      } while (cursor !== null)
      return machines
    },
    exec: (id: string, cmd: string, timeoutSeconds = 60) =>
      call<Exec>("POST", `/v1/machines/${id}/exec`, { cmd, timeoutSeconds, noHistory: true }),
    async read(id: string, path: string): Promise<string> {
      const response = await fetch(`${API}/v1/machines/${id}/files/content?path=${encodeURIComponent(path)}`, {
        headers: { "X-API-Key": key },
      })
      if (response.status === 404) return ""
      if (!response.ok) throw new InstaboxError(response.status, "read_failed", path)
      return response.text()
    },
    async write(id: string, path: string, body: string, mode = "0644"): Promise<void> {
      const response = await fetch(
        `${API}/v1/machines/${id}/files?path=${encodeURIComponent(path)}&mode=${mode}&parents=true`,
        { method: "PUT", headers: { "X-API-Key": key, "Content-Type": "application/octet-stream" }, body },
      )
      if (!response.ok) throw new InstaboxError(response.status, "write_failed", `${path}: ${await response.text()}`)
    },
    async snapshot(id: string, name: string): Promise<string> {
      await change("POST", `/v1/machines/${id}/snapshots`, { name })
      for (;;) {
        const { snapshots } = await call<{ snapshots: { id: string; name: string; status: string }[] }>(
          "GET",
          "/v1/snapshots",
        )
        const saved = snapshots.find((snapshot) => snapshot.name === name)
        if (saved?.status === "ready") return saved.id
        if (saved?.status === "failed") throw new InstaboxError(0, "snapshot_failed", name)
        await Bun.sleep(2000)
      }
    },
    snapshots: async () =>
      (
        await call<{ snapshots: { id: string; name: string; state: string; createdAt: string }[] }>(
          "GET",
          "/v1/snapshots",
        )
      ).snapshots,
    removeSnapshot: (id: string) =>
      call("DELETE", `/v1/snapshots/${id}`, undefined, {
        "Idempotency-Key": crypto.randomUUID(),
        "X-Confirm-Delete": id,
      }),
    lease: (id: string, task: string, ttlSeconds: number) =>
      call("PUT", `/v1/machines/${id}/activity-leases/${task}`, { ttlSeconds }),
    release: (id: string, task: string) => call("DELETE", `/v1/machines/${id}/activity-leases/${task}`),
    usage: (id: string) => call<{ costUSD?: number }>("GET", `/v1/machines/${id}/usage`),
  }
}

export type Instabox = ReturnType<typeof instabox>
