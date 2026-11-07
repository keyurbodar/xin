import type { Context } from "@deepseek-ai/cordis"
import type { PendingPackages } from "../../src/kernel/packages.ts"
import type { Deployed, Deployer } from "../../src/kernel/system.ts"

export const name = "deploy-hook"
export const inject = ["secrets"]

export const deployBody = (ref: string | undefined, packages: PendingPackages): string =>
  JSON.stringify({ ref: ref ?? "main", inputs: { packages: JSON.stringify(packages) } })

export function apply(ctx: Context): void {
  const secrets = ctx.secrets
  ctx.provide("deployer", {
    deploy: async (request): Promise<Deployed> => {
      const url = secrets.get("url")
      if (url === undefined) return { application: "failed", detail: "set the deploy-hook url secret first" }
      const reply = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(secrets.get("token")) },
        body: deployBody(secrets.get("ref"), request.packages),
      })
      return reply.ok
        ? { application: "deploying", detail: `deploy hook answered ${reply.status}` }
        : { application: "failed", detail: `deploy hook answered ${reply.status}` }
    },
  } satisfies Deployer)
}

const bearer = (token: string | undefined): Record<string, string> =>
  token === undefined ? {} : { authorization: `Bearer ${token}` }
