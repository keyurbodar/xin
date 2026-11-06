import type { Context } from "@deepseek-ai/cordis"
import type { JsonObject } from "@earendil-works/pi-durable"
import { bool, obj, opt } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"

declare const XIN_BUILD: string | undefined

export type Deployed = { readonly application: "deploying" | "failed"; readonly detail: string }

export type Deployer = { deploy(): Promise<Deployed> }

export type System = { version(): Promise<JsonObject> }

const build = (): string => (typeof XIN_BUILD === "string" ? XIN_BUILD : "dev")

const OWNER = ["owner"] as const

export const name = "system"
export const inject = ["host", "kernel", "ops", "http"]

export function apply(ctx: Context): void {
  const version = async (): Promise<JsonObject> => {
    const rows = await Promise.all(
      ctx.kernel.rows().map(async (row) => ({ id: row.id, state: (await ctx.kernel.state(row.id)).kind })),
    )
    return {
      build: build(),
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
        return { ...(await deployer.deploy()) }
      },
    }),
  )
}
