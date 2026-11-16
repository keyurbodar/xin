import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { join } from "node:path"
import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

const path = (relative: string) => join(import.meta.dirname, relative)
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2)

const LIVE_VARS = ["OPENCODE_API_KEY", "INGLE_LIVE_MODELS"] as const

function unquote(value: string): string {
  const quote = value[0]
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value
}

function parseDevVars(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) values[name] = unquote(value)
  }
  return values
}

function liveBindings(): Record<string, string> {
  const file = path("./.dev.vars")
  if (!existsSync(file)) throw new Error(`INGLE_LIVE=1 needs ${file}`)
  const dev = parseDevVars(readFileSync(file, "utf8"))
  const bindings: Record<string, string> = { INGLE_LIVE: "1" }
  for (const name of LIVE_VARS) {
    const value = dev[name]
    if (value === undefined) throw new Error(`INGLE_LIVE=1 needs ${name} in .dev.vars`)
    bindings[name] = value
  }
  return bindings
}

const PREBUNDLED = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/cordis-plugin-loader",
  "@deepseek-ai/schemastery",
  "@earendil-works/chord",
  "@earendil-works/chord/context",
  "@earendil-works/chord/sqlite",
  "@earendil-works/chord/sqlite/cloudflare",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/api/anthropic-messages.lazy",
  "@earendil-works/pi-ai/api/google-generative-ai.lazy",
  "@earendil-works/pi-ai/api/openai-completions.lazy",
  "@earendil-works/pi-ai/api/openai-responses.lazy",
  "@earendil-works/pi-ai/models",
  "@earendil-works/pi-ai/providers/all",
  "@earendil-works/pi-ai/providers/model-schema",
  "@earendil-works/pi-ai/providers/opencode-go",
  "@earendil-works/pi-ai/utils/estimate",
  "@earendil-works/pi-durable",
  "@earendil-works/pi-durable/env",
  "@earendil-works/pi-durable/storage/sqlite/cloudflare",
  "@earendil-works/pi-durable/testing",
  "@earendil-works/pi-durable/tool-search",
  "@earendil-works/pi-durable/tools",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-schema",
]

const live = process.env.INGLE_LIVE === "1"
const instabox = process.env.INSTABOX_API_KEY
const instaboxLive = process.env.INSTABOX_LIVE === "1" && instabox !== undefined && instabox !== ""
const instaboxBindings: Record<string, string> = instaboxLive
  ? { INSTABOX_API_KEY: instabox, INSTABOX_LIVE: "1" }
  : { INSTABOX_API_KEY: "ibk_fake" }
const load = process.env.INGLE_LOAD === "1"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path("./test/wrangler.jsonc") },
      miniflare: {
        serviceBindings: { ECHO: () => new Response("pong") },
        bindings: { ...instaboxBindings, ...(live ? liveBindings() : {}) },
      },
    }),
  ],
  resolve: {
    alias: { "node-addon-require-builtin": path("./test/no-require-builtin.cjs") },
  },
  test: {
    include: load ? ["test/**/*.bench.ts"] : ["src/**/*.test.ts", "plugins/**/*.test.ts", "test/**/*.test.ts"],
    deps: { optimizer: { ssr: { enabled: true, include: PREBUNDLED, rolldownOptions: { external: [/^node:/, /^cloudflare:/, ...builtinModules] } } } },
    maxWorkers,
    retry: 0,
  },
})
