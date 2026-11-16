import { defineExtension } from "@earendil-works/pi-durable"
import { type Context, Schema } from "../../src/kernel/index.ts"
import { instaboxBackend } from "./instabox.ts"
import { createSessions } from "./session.ts"
import { createTools } from "./tools.ts"

export const name = "tool-browser"
export const inject = ["pi", "jobs", "harness", "host"]

export const Config = Schema.object({
  idleMinutes: Schema.natural()
    .min(1)
    .max(1_440)
    .default(10)
    .description("Minutes without a browser call before the conversation's browser machine is stopped."),
  vcpus: Schema.natural()
    .min(1)
    .default(2)
    .description("vCPUs of each browser machine; one of the Instabox plan's sizes."),
  memMiB: Schema.natural()
    .min(512)
    .default(4_096)
    .description("Memory of each browser machine in MiB; one of the Instabox plan's sizes with vcpus."),
})

type Config = {
  readonly idleMinutes: number
  readonly vcpus: number
  readonly memMiB: number
}

export function apply(ctx: Context, config: Config): void {
  const backend = instaboxBackend({
    apiKey: ctx.host.env.INSTABOX_API_KEY,
    vcpus: config.vcpus,
    memMiB: config.memMiB,
  })
  const sessions = createSessions(backend, config.idleMinutes * 60_000)
  ctx.pi.install(
    defineExtension({
      name: "tool-browser",
      tools: createTools({ jobs: ctx.jobs, harness: ctx.harness, backend, sessions }),
      tasks: [sessions.idle],
    }),
  )
}
