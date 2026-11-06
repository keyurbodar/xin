import type { Context } from "@deepseek-ai/cordis"
import type { Deployed, Deployer } from "./system.ts"

export const name = "deploy-hook"
export const inject = ["secrets"]

export function apply(ctx: Context): void {
  const secrets = ctx.secrets
  ctx.provide("deployer", {
    deploy: async (): Promise<Deployed> => {
      const url = secrets.get("url")
      if (url === undefined) return { application: "failed", detail: "set the deploy-hook url secret first" }
      const reply = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(secrets.get("token")) },
        body: JSON.stringify({ ref: secrets.get("ref") ?? "main" }),
      })
      return reply.ok
        ? { application: "deploying", detail: `deploy hook answered ${reply.status}` }
        : { application: "failed", detail: `deploy hook answered ${reply.status}` }
    },
  } satisfies Deployer)
}

const bearer = (token: string | undefined): Record<string, string> =>
  token === undefined ? {} : { authorization: `Bearer ${token}` }
