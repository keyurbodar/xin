import type { Context } from "@deepseek-ai/cordis"
import { expandAll, waitingCredentials, type ExpandedAll, type SecretsPort } from "../../src/credentials.ts"
import { Schema } from "../../src/kernel/index.ts"
import type { PendingPackages } from "../../src/kernel/packages.ts"
import type { Deployed, Deployer } from "../../src/kernel/system.ts"

export const name = "deploy-hook"
export const inject = ["secrets"]

export const Config = Schema.object({
  url: Schema.string().description("The deploy hook URL. May contain ${credential:REF}."),
  token: Schema.string().description("A bearer token. May contain ${credential:REF}."),
  ref: Schema.string().default("main").description("The git ref to deploy. May contain ${credential:REF}."),
})

type Config = { readonly url?: string; readonly token?: string; readonly ref?: string }

export const deployBody = (ref: string | undefined, packages: PendingPackages): string =>
  JSON.stringify({ ref: ref ?? "main", inputs: { packages: JSON.stringify(packages) } })

export async function deploy(config: Config, secrets: SecretsPort, packages: PendingPackages): Promise<Deployed> {
  if (config.url === undefined) return { application: "failed", detail: "set the deploy-hook url first" }
  let resolved: ExpandedAll
  try {
    resolved = expandAll([config.url, config.token, config.ref], secrets)
  } catch (error) {
    return { application: "failed", detail: error instanceof Error ? error.message : String(error) }
  }
  if (resolved.kind === "missing") return { application: "failed", detail: waitingCredentials(resolved.refs) }
  const [url = config.url, token, ref] = resolved.texts
  const reply = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: deployBody(ref, packages),
  })
  return reply.ok
    ? { application: "deploying", detail: `deploy hook answered ${reply.status}` }
    : { application: "failed", detail: `deploy hook answered ${reply.status}` }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide("deployer", {
    deploy: (request) => deploy(config, ctx.secrets, request.packages),
  } satisfies Deployer)
}

const bearer = (token: string | undefined): Record<string, string> =>
  token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` }
