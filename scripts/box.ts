import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const BOXES_ENV = join(process.env.HOME ?? "", ".config/xin/boxes.env")
const LEASES = "/tmp/xin-gate/leases"
const BENCH_MS = 10 * 60_000
const WAIT_MS = 15 * 60_000
const SYNCED = "__XIN_GATE_SYNCED"
const EXIT = "__XIN_GATE_EXIT="

export type Box = { readonly machine: string; readonly key: string }
export type BoxRun =
  | { readonly kind: "ran"; readonly ok: boolean }
  | { readonly kind: "unavailable"; readonly reason: string }

export function boxes(): readonly Box[] {
  if (
    process.env.XIN_GATE_BOX === "0" ||
    process.env.XIN_LIVE === "1" ||
    process.env.XIN_LOAD === "1" ||
    !existsSync(BOXES_ENV)
  )
    return []
  return readFileSync(BOXES_ENV, "utf8")
    .split("\n")
    .map((line) => line.trim().split("="))
    .flatMap(([machine, key]) => (machine && key ? [{ machine, key }] : []))
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const leasePath = (box: Box) => join(LEASES, box.machine)
const benchPath = (box: Box) => join(LEASES, `${box.machine}.bench`)
const benched = (box: Box) => existsSync(benchPath(box)) && Date.now() - statSync(benchPath(box)).mtimeMs < BENCH_MS

function tryLease(box: Box): boolean {
  mkdirSync(LEASES, { recursive: true })
  try {
    mkdirSync(leasePath(box))
  } catch {
    const holder = Number(readFileSync(join(leasePath(box), "pid"), { encoding: "utf8", flag: "a+" }))
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) return false
    rmSync(leasePath(box), { recursive: true, force: true })
    return tryLease(box)
  }
  writeFileSync(join(leasePath(box), "pid"), String(process.pid))
  return true
}

export function leases(): readonly string[] {
  return boxes().map((box) => {
    if (benched(box)) return `${box.machine}: benched`
    const pid = existsSync(leasePath(box)) ? Number(readFileSync(join(leasePath(box), "pid"), "utf8")) : 0
    return `${box.machine}: ${pid > 0 && alive(pid) ? `busy pid ${pid}` : "free"}`
  })
}

async function lease(): Promise<Box | undefined> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    const usable = boxes().filter((box) => !benched(box))
    if (usable.length === 0) return undefined
    const free = usable.find(tryLease)
    if (free !== undefined) return free
    await Bun.sleep(2000)
  }
  return undefined
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const boxDir = (root: string) => `/data/build/${createHash("sha256").update(root).digest("hex").slice(0, 12)}`

function exec(box: Box, flag: "--stdin" | "--stream", command: string, input?: Buffer) {
  return spawnSync("instabox", ["exec", flag, "--timeout", "600", box.machine, "--", command], {
    input,
    encoding: "utf8",
    env: { ...process.env, INSTABOX_API_KEY: box.key },
    maxBuffer: 256 << 20,
  })
}

function sync(box: Box, root: string): string | undefined {
  const files = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
  const archive = spawnSync("tar", ["--null", "-T", "-", "-czf", "-"], {
    cwd: root,
    input: files.stdout,
    maxBuffer: 1 << 30,
  })
  if (archive.status !== 0) return `tar failed: ${archive.stderr}`
  const unpack = [
    `set -e; mkdir -p ${boxDir(root)}; cd ${boxDir(root)}`,
    `find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +`,
    `tar -xzf -`,
    `h=$(sha256sum bun.lock | cut -c1-64)`,
    `if [ "$(cat node_modules/.xin-lock 2>/dev/null)" != "$h" ]; then ~/.bun/bin/bun install --frozen-lockfile >/dev/null 2>&1; echo "$h" > node_modules/.xin-lock; fi`,
    `echo ${SYNCED}`,
  ].join("\n")
  const run = exec(box, "--stdin", unpack, archive.stdout)
  return run.stdout.includes(SYNCED) ? undefined : `sync failed (${run.status}): ${run.stderr.slice(-400)}`
}

function attempt(box: Box, root: string, script: string, extra: readonly string[], log: string): BoxRun {
  const problem = sync(box, root)
  if (problem !== undefined) return { kind: "unavailable", reason: problem }
  const command = [
    `cd ${boxDir(root)}`,
    `export PATH=$HOME/.bun/bin:$PATH FORCE_COLOR=0 NO_COLOR=1 VITEST_MAX_WORKERS=3 GATE=1`,
    `bun run ${script} ${extra.map(quote).join(" ")} 2>&1; echo "${EXIT}$?"`,
  ].join("\n")
  const run = exec(box, "--stream", command)
  const marker = run.stdout.lastIndexOf(EXIT)
  if (marker === -1) return { kind: "unavailable", reason: `failed mid-run: ${run.stderr.slice(-400)}` }
  appendFileSync(log, `gate: ran on box ${box.machine}\n${run.stdout.slice(0, marker)}`)
  return { kind: "ran", ok: run.stdout.slice(marker + EXIT.length).trim() === "0" }
}

export async function runOnBox(root: string, script: string, extra: readonly string[], log: string): Promise<BoxRun> {
  for (;;) {
    const box = await lease()
    if (box === undefined) return { kind: "unavailable", reason: "no box free or usable" }
    try {
      const run = attempt(box, root, script, extra, log)
      if (run.kind === "ran") return run
      appendFileSync(log, `gate: box ${box.machine} unavailable, benched 10 min. ${run.reason}\n`)
      writeFileSync(benchPath(box), "")
    } finally {
      rmSync(leasePath(box), { recursive: true, force: true })
    }
  }
}
