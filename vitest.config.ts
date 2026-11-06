import { join } from "node:path"
import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

const path = (relative: string) => join(import.meta.dirname, relative)
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2)

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path("./test/wrangler.jsonc") },
      miniflare: { serviceBindings: { ECHO: () => new Response("pong") } },
    }),
  ],
  test: { include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "test/**/*.test.ts"], maxWorkers, retry: 0 },
})
