import { defineExtension } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"
import { MIGRATIONS } from "./store.ts"
import { createTools } from "./tools.ts"

export const name = "tool-git-native"
export const inject = ["pi", "db", "host"]

export async function apply(ctx: Context): Promise<void> {
  await ctx.db.applySqliteMigrations("git_native", MIGRATIONS)
  ctx.pi.install(
    defineExtension({
      name: "tool-git-native",
      tools: createTools({
        db: ctx.db,
        bucket: ctx.host.env.FILES,
        fetcher: (input, init) => fetch(input, init),
        now: () => Date.now(),
      }),
    }),
  )
}
