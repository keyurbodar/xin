import type { Context } from "@deepseek-ai/cordis"
import type { JsonObject } from "@earendil-works/pi-durable"
import { bool, obj, opt } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"
import { ring } from "./logs.ts"
import { buildId, type PendingPackages } from "./packages.ts"

export type DeployRequest = { readonly packages: PendingPackages }

export type Deployed = { readonly application: "deploying" | "failed"; readonly detail: string }

export type Deployer = { deploy(request: DeployRequest): Promise<Deployed> }

export type System = { version(): Promise<JsonObject> }

export type Metrics = {
  readonly uptimeMs: number
  readonly storageBytes: number
  readonly sockets: number
  readonly rows: { readonly total: number; readonly active: number }
  readonly pushDevices: number
}

const PUSH_DEVICES_SQL = "SELECT count(*) AS count FROM push_subs"

const OWNER = ["owner"] as const

export const name = "system"
export const inject = ["db", "host", "http", "kernel", "ops", "packages"]

export function apply(ctx: Context): void {
  const startedAt = Date.now()
  const logs = ring()
  const metrics = async (): Promise<Metrics> => {
    const states = await Promise.all(ctx.kernel.rows().map((row) => ctx.kernel.state(row.id)))
    const push = await ctx.db.get<{ count: number }>(PUSH_DEVICES_SQL)
    if (push === undefined) throw new Error("push device count returned no row")
    return {
      uptimeMs: Date.now() - startedAt,
      storageBytes: ctx.host.state.storage.sql.databaseSize,
      sockets: ctx.host.state.getWebSockets().length,
      rows: { total: states.length, active: states.filter((state) => state.kind === "active").length },
      pushDevices: push.count,
    }
  }
  const version = async (): Promise<JsonObject> => {
    const rows = await Promise.all(
      ctx.kernel.rows().map(async (row) => ({ id: row.id, state: (await ctx.kernel.state(row.id)).kind })),
    )
    return {
      build: buildId(),
      bundles: [...ctx.kernel.composition.profile.bundles],
      degraded: rows.some((row) => row.state === "failed" || row.state === "missing"),
      rows,
    }
  }
  ctx.provide("system", { version } satisfies System)
  ctx.http.route("GET /v1/status", async () =>
    Response.json({ wake: ctx.get("harness")?.wake() ?? null, ...(await version()) }),
  )
  ctx.ops.define(defineOp({ name: "system.version", args: obj({}), actors: OWNER, run: async () => version() }))
  ctx.ops.define(defineOp({ name: "system.metrics", args: obj({}), actors: OWNER, run: async () => metrics() }))
  ctx.ops.define(
    defineOp({
      name: "system.logs",
      args: obj({}),
      actors: OWNER,
      run: async () => ({ entries: [...logs.entries()] }),
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "system.restart",
      args: obj({ hard: opt(bool()) }),
      actors: OWNER,
      run: async (_api, args) => {
        if (args.hard === true) {
          setTimeout(() => ctx.host.abort("system.restart"), 0)
          return { application: "restarting", hard: true }
        }
        setTimeout(() => void ctx.host.restart(), 0)
        return { application: "restarting", hard: false }
      },
    }),
  )
  ctx.ops.define(
    defineOp({
      name: "system.update",
      args: obj({}),
      actors: OWNER,
      run: async () => {
        const deployer = ctx.get("deployer")
        if (deployer === undefined) return { application: "failed", detail: "no deployer row is active" }
        return { ...(await deployer.deploy({ packages: ctx.packages.pending() })) }
      },
    }),
  )
}
