import { existsSync } from "node:fs"
import { join } from "node:path"
import { DEV_TOKEN } from "./devvars.ts"

const ROOT = join(import.meta.dirname, "..")
const PORT = 8798
const WORKER = `http://127.0.0.1:${PORT}`
const DEADLINE_MS = 120_000
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

if (existsSync(join(ROOT, ".dev.vars"))) {
  console.warn(
    "dev:smoke skipped: it checks the run without .dev.vars, and this checkout has one (CI and the boxes have none)",
  )
  process.exit(0)
}

if (!existsSync(join(ROOT, "web", "node_modules"))) {
  const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
    cwd: join(ROOT, "web"),
    stdout: "inherit",
    stderr: "inherit",
  })
  if (install.exitCode !== 0) throw new Error(`dev:smoke: bun install in web/ exited with ${install.exitCode}`)
}

const dev = Bun.spawn(["bun", "scripts/ingle.ts", "plugin", "dev", "--port", String(PORT)], {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
})
let output = ""
const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const text = decoder.decode(chunk)
    output += text
    process.stderr.write(text)
  }
}
void collect(dev.stdout)
void collect(dev.stderr)

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + DEADLINE_MS
  while (Date.now() < end) {
    if (dev.exitCode !== null) throw new Error(`plugin dev exited with ${dev.exitCode} before ${what}`)
    const value = await probe().catch(() => undefined)
    if (value !== undefined) return value
    await Bun.sleep(1000)
  }
  throw new Error(`plugin dev: no ${what} within ${DEADLINE_MS / 1000}s`)
}

try {
  const ack = await until("Home that seals a secret", async () => {
    const response = await fetch(`${WORKER}/v1/cmd`, {
      method: "POST",
      headers: { authorization: `Bearer ${DEV_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        id: `smoke-${crypto.randomUUID()}`,
        op: "secret.set",
        args: { ref: "smoke", value: "s" },
      }),
    })
    const body: unknown = await response.json()
    return typeof body === "object" && body !== null && Reflect.get(body, "ok") === true ? body : undefined
  })
  const web = await until(
    "web dev server",
    async () => /Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/.exec(output.replaceAll(ANSI, ""))?.[1],
  )
  const page = await until("web page", async () => ((await fetch(web)).ok ? web : undefined))
  console.warn(`dev:smoke ok: the Home sealed a secret (${JSON.stringify(ack)}) and ${page} served the shell`)
} finally {
  dev.kill("SIGTERM")
  await Promise.race([dev.exited, Bun.sleep(10_000)])
  if (dev.exitCode === null) dev.kill("SIGKILL")
}
