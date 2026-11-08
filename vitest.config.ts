import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

const path = (relative: string) => join(import.meta.dirname, relative)
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2)

const LIVE_VARS = ["OPENCODE_API_KEY", "XIN_LIVE_MODELS"] as const

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
  if (!existsSync(file)) throw new Error(`XIN_LIVE=1 needs ${file}`)
  const dev = parseDevVars(readFileSync(file, "utf8"))
  const bindings: Record<string, string> = { XIN_LIVE: "1" }
  for (const name of LIVE_VARS) {
    const value = dev[name]
    if (value === undefined) throw new Error(`XIN_LIVE=1 needs ${name} in .dev.vars`)
    bindings[name] = value
  }
  return bindings
}

const live = process.env.XIN_LIVE === "1"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path("./test/wrangler.jsonc") },
      miniflare: {
        serviceBindings: { ECHO: () => new Response("pong") },
        ...(live ? { bindings: liveBindings() } : {}),
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "test/**/*.test.ts"], maxWorkers, retry: 0 },
})
