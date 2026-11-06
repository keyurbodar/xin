#!/usr/bin/env bun
// The one way to run format, lint, typecheck, tests and bundle checks.
//
//   bun scripts/gate.ts [run] [steps…] [--only=path] [--force]   run now, queued behind the machine-wide lock
//   bun scripts/gate.ts submit [steps…] [--only=path]            enqueue for the background runner, print a job id, return
//   bun scripts/gate.ts wait <id> [--timeout=seconds]            block until that job has a result
//   bun scripts/gate.ts status                                   runner, queue, last results, free disk
//   bun scripts/gate.ts serve                                    the background runner (submit starts it when needed)
//
// Steps: fmt lint types test bundle (default: all). A step that passed is cached until its inputs change.
// Identical jobs queued within the same 1.5 s window (same checkout, steps, filter) run once and share the result.
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

const SELF = import.meta.filename
const HOME_ROOT = resolve(import.meta.dirname, "..")
const BASE = "/tmp/xin-gate"
const QUEUE = join(BASE, "queue")
const RUNNING = join(BASE, "running")
const RESULTS = join(BASE, "results")
const LOCK = join(BASE, "lock")
const HOLDER = join(BASE, "holder")
const SERVE_PID = join(BASE, "serve.pid")
const SERVE_IDLE_MS = 10 * 60_000
const ORDER = ["fmt", "lint", "types", "test", "bundle"] as const
type Step = (typeof ORDER)[number]
const SCRIPT: Record<Step, string> = { fmt: "fmt:check", lint: "lint", types: "typecheck", test: "test", bundle: "bundle" }
type Outcome = "pass" | "fail" | "cached" | "missing"
type StepResult = { step: Step; outcome: Outcome; seconds: number; log: string }
type JobResult = { id: string; root: string; ok: boolean; at: string; results: StepResult[]; aliases: string[] }
type Job = { id: string; root: string; gate: string; steps: Step[]; only: string[]; submittedAt: string }

const isStep = (value: string): value is Step => ORDER.some((step) => step === value)

type Args = { command: "run" | "submit" | "wait" | "status" | "serve"; steps: Step[]; only: string[]; force: boolean; id?: string; timeoutS: number; resultPath?: string; root: string }

function parseArgs(argv: readonly string[]): Args {
  const commands = ["run", "submit", "wait", "status", "serve"] as const
  const first = argv[0]
  const command = commands.find((name) => name === first) ?? (first === "--status" ? "status" : "run")
  const rest = commands.some((name) => name === first) || first === "--status" ? argv.slice(1) : argv
  const flag = (name: string) => rest.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3))
  const named = rest.filter((arg) => !arg.startsWith("--"))
  if (command === "wait") {
    const id = named[0]
    if (id === undefined) fail("gate wait: job id required")
    return { command, steps: [], only: [], force: false, id, timeoutS: Number(flag("timeout")[0] ?? 1800), root: HOME_ROOT }
  }
  const unknown = named.filter((arg) => arg !== "all" && !isStep(arg))
  if (unknown.length > 0) fail(`gate: unknown step ${unknown.join(", ")}. Steps: ${ORDER.join(", ")}, all`)
  const steps = named.length === 0 || named.includes("all") ? [...ORDER] : ORDER.filter((step) => named.includes(step))
  return {
    command,
    steps,
    only: flag("only"),
    force: rest.includes("--force"),
    timeoutS: 1800,
    resultPath: flag("result")[0],
    root: resolve(flag("root")[0] ?? HOME_ROOT),
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function packageScripts(root: string): Record<string, string> {
  const pkg = readJson(join(root, "package.json"))
  return typeof pkg === "object" && pkg !== null && "scripts" in pkg ? stringRecord(pkg.scripts) : {}
}

function inputKey(root: string, step: Step, extra: readonly string[]): string {
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  const files = listed.stdout
    .split("\0")
    .filter((file) => file !== "" && !file.startsWith("docs/") && !file.startsWith(".gate/"))
    .sort()
  const hash = createHash("sha256").update(`${step}\0${Bun.version}\0${extra.join(",")}\0`)
  for (const file of files) {
    const path = join(root, file)
    if (existsSync(path)) hash.update(file).update("\0").update(readFileSync(path)).update("\0")
  }
  return hash.digest("hex")
}

function runStep(root: string, step: Step, force: boolean, only: readonly string[]): StepResult {
  const out = join(root, ".gate")
  mkdirSync(out, { recursive: true })
  const log = join(out, `${step}.log`)
  const script = SCRIPT[step]
  if (packageScripts(root)[script] === undefined) return { step, outcome: "missing", seconds: 0, log }
  const extra = step === "test" ? only : []
  const key = inputKey(root, step, extra)
  const cachePath = join(out, "cache.json")
  const cache = stringRecord(readJson(cachePath))
  if (!force && cache[step] === key) return { step, outcome: "cached", seconds: 0, log }
  const started = performance.now()
  writeFileSync(log, `$ bun run ${script} ${extra.join(" ")}\n`)
  const run = spawnSync("nice", ["-n", "10", "bun", "run", script, ...extra], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    env: { ...process.env, FORCE_COLOR: "0", VITEST_MAX_WORKERS: "2", GATE: "1" },
  })
  appendFileSync(log, `${run.stdout}${run.stderr}`)
  const seconds = Math.round((performance.now() - started) / 100) / 10
  const passed = run.status === 0
  if (passed) writeFileSync(cachePath, JSON.stringify({ ...stringRecord(readJson(cachePath)), [step]: key }, null, 2))
  return { step, outcome: passed ? "pass" : "fail", seconds, log }
}

function tail(path: string, lines: number): string {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(-lines).join("\n") : ""
}

function printResult(result: JobResult): void {
  for (const r of result.results) console.log(`gate: ${r.step.padEnd(6)} ${r.outcome}${r.seconds > 0 ? ` ${r.seconds}s` : ""}`)
  const failed = result.results.find((r) => r.outcome === "fail")
  if (failed !== undefined) console.log(`--- ${failed.log}\n${tail(failed.log, 60)}`)
}

function ensureDirs(): void {
  for (const dir of [QUEUE, RUNNING, RESULTS]) mkdirSync(dir, { recursive: true })
}

// run: take the lock (re-exec under flock), run steps in order, stop at the first failure.
function commandRun(args: Args): never {
  ensureDirs()
  if (process.env.XIN_GATE_LOCKED !== "1") {
    const holder = existsSync(HOLDER) ? readFileSync(HOLDER, "utf8").trim() : ""
    if (holder !== "") console.log(`gate: queued behind ${holder}`)
    const queued = spawnSync("flock", [LOCK, process.execPath, SELF, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, XIN_GATE_LOCKED: "1" },
    })
    process.exit(queued.status ?? 1)
  }
  writeFileSync(HOLDER, `pid ${process.pid} in ${args.root} since ${new Date().toISOString()}`)
  const results: StepResult[] = []
  for (const step of args.steps) {
    const result = runStep(args.root, step, args.force, args.only)
    results.push(result)
    if (result.outcome === "fail") break
  }
  writeFileSync(HOLDER, "")
  const ok = !results.some((r) => r.outcome === "fail")
  const job: JobResult = { id: "direct", root: args.root, ok, at: new Date().toISOString(), results, aliases: [] }
  writeFileSync(join(args.root, ".gate", "last.json"), JSON.stringify(job, null, 2))
  if (args.resultPath !== undefined) writeFileSync(args.resultPath, JSON.stringify(job))
  else printResult(job)
  process.exit(ok ? 0 : 1)
}

function serveAlive(): boolean {
  const pid = Number(readJson(SERVE_PID))
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function commandSubmit(args: Args): void {
  ensureDirs()
  const job: Job = { id: randomUUID().slice(0, 8), root: args.root, gate: SELF, steps: args.steps, only: args.only, submittedAt: new Date().toISOString() }
  writeFileSync(join(QUEUE, `${Date.now()}-${job.id}.json`), JSON.stringify(job))
  if (!serveAlive()) {
    const logFd = openSync(join(BASE, "serve.log"), "a")
    spawn(process.execPath, [SELF, "serve"], { detached: true, stdio: ["ignore", logFd, logFd] }).unref()
  }
  console.log(job.id)
}

function parseJob(value: unknown): Job | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (!("id" in value) || !("root" in value) || !("gate" in value) || !("steps" in value) || !("only" in value)) return undefined
  const { id, root, gate, steps, only } = value
  if (typeof id !== "string" || typeof root !== "string" || typeof gate !== "string") return undefined
  if (!Array.isArray(steps) || !Array.isArray(only)) return undefined
  const validSteps = steps.filter((s): s is Step => typeof s === "string" && isStep(s))
  const validOnly = only.filter((s): s is string => typeof s === "string")
  return { id, root, gate, steps: validSteps, only: validOnly, submittedAt: "" }
}

const jobKey = (job: Job) => `${job.root}\0${job.gate}\0${job.steps.join(",")}\0${job.only.join(",")}`

// serve: one job at a time, oldest first; identical queued jobs are claimed together and share the result.
async function commandServe(): Promise<void> {
  ensureDirs()
  if (serveAlive() && Number(readJson(SERVE_PID)) !== process.pid) return
  writeFileSync(SERVE_PID, JSON.stringify(process.pid))
  let idleSince = Date.now()
  while (Date.now() - idleSince < SERVE_IDLE_MS) {
    const files = readdirSync(QUEUE).filter((f) => f.endsWith(".json")).sort()
    const head = files[0]
    if (head === undefined) {
      await Bun.sleep(1000)
      continue
    }
    await Bun.sleep(1500)
    const lead = parseJob(readJson(join(QUEUE, head)))
    if (lead === undefined) {
      rmSync(join(QUEUE, head), { force: true })
      continue
    }
    const claimed: Job[] = []
    for (const file of readdirSync(QUEUE).filter((f) => f.endsWith(".json")).sort()) {
      const job = parseJob(readJson(join(QUEUE, file)))
      if (job === undefined || jobKey(job) !== jobKey(lead)) continue
      renameSync(join(QUEUE, file), join(RUNNING, file))
      claimed.push(job)
    }
    const resultPath = join(RESULTS, `${lead.id}.json`)
    const onlyFlags = lead.only.map((path) => `--only=${path}`)
    spawnSync(process.execPath, [lead.gate, "run", ...lead.steps, ...onlyFlags, `--root=${lead.root}`, `--result=${resultPath}`], {
      stdio: "ignore",
    })
    const raw = readJson(resultPath)
    const base: JobResult =
      typeof raw === "object" && raw !== null && "results" in raw && Array.isArray(raw.results) && "ok" in raw && typeof raw.ok === "boolean"
        ? { id: lead.id, root: lead.root, ok: raw.ok, at: new Date().toISOString(), results: raw.results, aliases: [] }
        : { id: lead.id, root: lead.root, ok: false, at: new Date().toISOString(), results: [], aliases: [] }
    const aliases = claimed.map((job) => job.id)
    for (const job of claimed) writeFileSync(join(RESULTS, `${job.id}.json`), JSON.stringify({ ...base, id: job.id, aliases }))
    for (const file of readdirSync(RUNNING)) rmSync(join(RUNNING, file), { force: true })
    idleSince = Date.now()
  }
  rmSync(SERVE_PID, { force: true })
}

function parseResult(value: unknown): JobResult | undefined {
  if (typeof value !== "object" || value === null || !("ok" in value) || !("results" in value)) return undefined
  if (typeof value.ok !== "boolean" || !Array.isArray(value.results)) return undefined
  const results = value.results.filter(
    (r): r is StepResult => typeof r === "object" && r !== null && "step" in r && "outcome" in r && "log" in r && "seconds" in r,
  )
  return { id: "", root: "", ok: value.ok, at: "", results, aliases: [] }
}

async function commandWait(args: Args): Promise<never> {
  const path = join(RESULTS, `${args.id}.json`)
  const deadline = Date.now() + args.timeoutS * 1000
  while (Date.now() < deadline) {
    const result = parseResult(readJson(path))
    if (result !== undefined) {
      printResult(result)
      process.exit(result.ok ? 0 : 1)
    }
    await Bun.sleep(1000)
  }
  console.log(`gate: job ${args.id} still pending after ${args.timeoutS}s (gate status shows the queue)`)
  process.exit(3)
}

function commandStatus(): void {
  ensureDirs()
  const free = statfsSync(HOME_ROOT)
  const freeGb = Math.round((free.bavail * free.bsize) / 1e9)
  console.log(`runner: ${serveAlive() ? "up" : "down"} · lock: ${(existsSync(HOLDER) ? readFileSync(HOLDER, "utf8").trim() : "") || "free"} · disk free: ${freeGb} GB`)
  console.log(`queued: ${readdirSync(QUEUE).length} · running: ${readdirSync(RUNNING).length}`)
  const recent = readdirSync(RESULTS)
    .map((f) => ({ f, r: parseResult(readJson(join(RESULTS, f))) }))
    .slice(-8)
  for (const { f, r } of recent) console.log(`  ${f.replace(".json", "")}  ${r?.ok ? "ok" : "FAIL"}  ${r?.results.map((s) => `${s.step}:${s.outcome}`).join(" ")}`)
}

const args = parseArgs(process.argv.slice(2))
switch (args.command) {
  case "run":
    commandRun(args)
    break
  case "submit":
    commandSubmit(args)
    break
  case "wait":
    await commandWait(args)
    break
  case "status":
    commandStatus()
    break
  case "serve":
    await commandServe()
    break
  default: {
    const _exhaustive: never = args.command
    throw new Error(`unreachable ${_exhaustive}`)
  }
}
