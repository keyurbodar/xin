#!/usr/bin/env bun
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
import { boxes, leases, runOnBox } from "./box.ts"

const SELF = import.meta.filename
const HOME_ROOT = resolve(import.meta.dirname, "..")
const BASE = "/tmp/xin-gate"
const QUEUE = join(BASE, "queue")
const RUNNING = join(BASE, "running")
const RESULTS = join(BASE, "results")
const LOCK = join(BASE, "lock")
const SERVE_PID = join(BASE, "serve.pid")
const SERVE_IDLE_MS = 10 * 60_000
const ORDER = ["fmt", "lint", "types", "test", "bundle"] as const
type Step = (typeof ORDER)[number]
const SCRIPT: Record<Step, string> = {
  fmt: "fmt:check",
  lint: "lint",
  types: "typecheck",
  test: "test",
  bundle: "bundle",
}
type Outcome = "pass" | "fail" | "cached" | "missing"
type StepResult = { step: Step; outcome: Outcome; seconds: number; log: string }
type JobResult = { id: string; root: string; ok: boolean; at: string; results: StepResult[]; aliases: string[] }
type Job = { id: string; root: string; gate: string; steps: Step[]; only: string[]; submittedAt: string }

const isStep = (value: string): value is Step => ORDER.some((step) => step === value)
const BOX_STEPS: ReadonlySet<Step> = new Set(["test", "bundle"])

type Args = {
  command: "run" | "submit" | "wait" | "status" | "serve"
  steps: Step[]
  only: string[]
  force: boolean
  id?: string
  timeoutS: number
  resultPath?: string
  root: string
}

function parseArgs(argv: readonly string[]): Args {
  const commands = ["run", "submit", "wait", "status", "serve"] as const
  const first = argv[0]
  const command = commands.find((name) => name === first) ?? (first === "--status" ? "status" : "run")
  const rest = commands.some((name) => name === first) || first === "--status" ? argv.slice(1) : argv
  const flag = (name: string) =>
    rest.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3))
  const named = rest.filter((arg) => !arg.startsWith("--"))
  if (command === "wait") {
    const id = named[0]
    if (id === undefined) fail("gate wait: job id required")
    return {
      command,
      steps: [],
      only: [],
      force: false,
      id,
      timeoutS: Number(flag("timeout")[0] ?? 1800),
      root: HOME_ROOT,
    }
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
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
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
    .toSorted()
  const hash = createHash("sha256").update(`${step}\0${Bun.version}\0${extra.join(",")}\0`)
  for (const file of files) {
    const path = join(root, file)
    if (existsSync(path)) hash.update(file).update("\0").update(readFileSync(path)).update("\0")
  }
  return hash.digest("hex")
}

const slug = (only: readonly string[]) =>
  only.length === 0 ? "" : `-${createHash("sha256").update(only.join(",")).digest("hex").slice(0, 8)}`

async function runStep(root: string, step: Step, force: boolean, only: readonly string[]): Promise<StepResult> {
  const extra = step === "test" ? only : []
  const out = join(root, ".gate")
  mkdirSync(join(out, "cache"), { recursive: true })
  const log = join(out, `${step}${slug(extra)}.log`)
  const script = SCRIPT[step]
  if (packageScripts(root)[script] === undefined) return { step, outcome: "missing", seconds: 0, log }
  const key = inputKey(root, step, extra)
  const cachePath = join(out, "cache", `${step}${slug(extra)}`)
  if (!force && existsSync(cachePath) && readFileSync(cachePath, "utf8") === key)
    return { step, outcome: "cached", seconds: 0, log }
  const started = performance.now()
  writeFileSync(log, `$ bun run ${script} ${extra.join(" ")}\n`)
  const remote = BOX_STEPS.has(step) ? await runOnBox(root, script, extra, log) : undefined
  const passed = remote?.kind === "ran" ? remote.ok : runLocal(root, step, script, extra, log)
  const seconds = Math.round((performance.now() - started) / 100) / 10
  if (passed) writeFileSync(cachePath, key)
  return { step, outcome: passed ? "pass" : "fail", seconds, log }
}

function runLocal(root: string, step: Step, script: string, extra: readonly string[], log: string): boolean {
  const command = ["nice", "-n", "10", "bun", "run", script, ...extra]
  const [program, ...rest] = BOX_STEPS.has(step) ? ["flock", LOCK, ...command] : command
  const run = spawnSync(program ?? "nice", rest, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    env: { ...process.env, FORCE_COLOR: "0", VITEST_MAX_WORKERS: "2", GATE: "1" },
  })
  appendFileSync(log, `${run.stdout}${run.stderr}`)
  return run.status === 0
}

function tail(path: string, lines: number): string {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(-lines).join("\n") : ""
}

function printResult(result: JobResult): void {
  for (const r of result.results)
    console.log(`gate: ${r.step.padEnd(6)} ${r.outcome}${r.seconds > 0 ? ` ${r.seconds}s` : ""}`)
  const failed = result.results.find((r) => r.outcome === "fail")
  if (failed !== undefined) console.log(`--- ${failed.log}\n${tail(failed.log, 60)}`)
}

function ensureDirs(): void {
  for (const dir of [QUEUE, RUNNING, RESULTS]) mkdirSync(dir, { recursive: true })
}

async function commandRun(args: Args): Promise<never> {
  ensureDirs()
  const results: StepResult[] = []
  for (const step of args.steps) {
    const result = await runStep(args.root, step, args.force, args.only)
    results.push(result)
    if (result.outcome === "fail") break
  }
  const ok = !results.some((r) => r.outcome === "fail")
  const job: JobResult = { id: "direct", root: args.root, ok, at: new Date().toISOString(), results, aliases: [] }
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
  const job: Job = {
    id: randomUUID().slice(0, 8),
    root: args.root,
    gate: SELF,
    steps: args.steps,
    only: args.only,
    submittedAt: new Date().toISOString(),
  }
  writeFileSync(join(QUEUE, `${Date.now()}-${job.id}.json`), JSON.stringify(job))
  if (!serveAlive()) {
    const logFd = openSync(join(BASE, "serve.log"), "a")
    spawn(process.execPath, [SELF, "serve"], { detached: true, stdio: ["ignore", logFd, logFd] }).unref()
  }
  console.log(job.id)
}

function parseJob(value: unknown): Job | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (!("id" in value) || !("root" in value) || !("gate" in value) || !("steps" in value) || !("only" in value))
    return undefined
  const { id, root, gate, steps, only } = value
  if (typeof id !== "string" || typeof root !== "string" || typeof gate !== "string") return undefined
  if (!Array.isArray(steps) || !Array.isArray(only)) return undefined
  const validSteps = steps.filter((s): s is Step => typeof s === "string" && isStep(s))
  const validOnly = only.filter((s): s is string => typeof s === "string")
  return { id, root, gate, steps: validSteps, only: validOnly, submittedAt: "" }
}

const jobKey = (job: Job) => `${job.root}\0${job.gate}\0${job.steps.join(",")}\0${job.only.join(",")}`

function finish(lead: Job, claimed: readonly Job[], files: readonly string[]): void {
  const resultPath = join(RESULTS, `${lead.id}.json`)
  const raw = parseResult(readJson(resultPath))
  const at = new Date().toISOString()
  const base: JobResult = {
    id: lead.id,
    root: lead.root,
    ok: raw?.ok ?? false,
    at,
    results: raw?.results ?? [],
    aliases: [],
  }
  const aliases = claimed.map((job) => job.id)
  for (const job of claimed)
    writeFileSync(join(RESULTS, `${job.id}.json`), JSON.stringify({ ...base, id: job.id, aliases }))
  for (const file of files) rmSync(join(RUNNING, file), { force: true })
}

function claim(): { lead: Job; claimed: Job[]; files: string[] } | undefined {
  const queued = readdirSync(QUEUE)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
  const head = queued[0]
  if (head === undefined) return undefined
  const lead = parseJob(readJson(join(QUEUE, head)))
  if (lead === undefined) {
    rmSync(join(QUEUE, head), { force: true })
    return claim()
  }
  const claimed: Job[] = []
  const files: string[] = []
  for (const file of queued) {
    const job = parseJob(readJson(join(QUEUE, file)))
    if (job === undefined || jobKey(job) !== jobKey(lead)) continue
    renameSync(join(QUEUE, file), join(RUNNING, file))
    claimed.push(job)
    files.push(file)
  }
  return { lead, claimed, files }
}

async function commandServe(): Promise<void> {
  ensureDirs()
  if (serveAlive() && Number(readJson(SERVE_PID)) !== process.pid) return
  writeFileSync(SERVE_PID, JSON.stringify(process.pid))
  const live = new Set<Promise<void>>()
  let idleSince = Date.now()
  while (live.size > 0 || Date.now() - idleSince < SERVE_IDLE_MS) {
    const slots = Math.max(1, boxes().length)
    const pending = readdirSync(QUEUE).some((f) => f.endsWith(".json"))
    if (live.size >= slots || !pending) {
      await Promise.race([Bun.sleep(1000), ...live])
      continue
    }
    await Bun.sleep(1500)
    const batch = claim()
    if (batch === undefined) continue
    const { lead, claimed, files } = batch
    const onlyFlags = lead.only.map((path) => `--only=${path}`)
    const resultPath = join(RESULTS, `${lead.id}.json`)
    const child = Bun.spawn(
      [
        process.execPath,
        lead.gate,
        "run",
        ...lead.steps,
        ...onlyFlags,
        `--root=${lead.root}`,
        `--result=${resultPath}`,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    )
    const done: Promise<void> = child.exited.then(() => {
      finish(lead, claimed, files)
      live.delete(done)
      idleSince = Date.now()
    })
    live.add(done)
  }
  rmSync(SERVE_PID, { force: true })
}

function parseResult(value: unknown): JobResult | undefined {
  if (typeof value !== "object" || value === null || !("ok" in value) || !("results" in value)) return undefined
  if (typeof value.ok !== "boolean" || !Array.isArray(value.results)) return undefined
  const results = value.results.filter(
    (r): r is StepResult =>
      typeof r === "object" && r !== null && "step" in r && "outcome" in r && "log" in r && "seconds" in r,
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
  console.log(`runner: ${serveAlive() ? "up" : "down"} · disk free: ${freeGb} GB`)
  const pool = leases()
  console.log(`boxes (${[...BOX_STEPS].join(", ")}): ${pool.length === 0 ? "none, all steps local" : pool.join(" · ")}`)
  console.log(`queued: ${readdirSync(QUEUE).length} · running: ${readdirSync(RUNNING).length}`)
  const recent = readdirSync(RESULTS)
    .map((f) => ({ f, r: parseResult(readJson(join(RESULTS, f))) }))
    .slice(-8)
  for (const { f, r } of recent)
    console.log(
      `  ${f.replace(".json", "")}  ${r?.ok ? "ok" : "FAIL"}  ${r?.results.map((s) => `${s.step}:${s.outcome}`).join(" ")}`,
    )
}

const args = parseArgs(process.argv.slice(2))
switch (args.command) {
  case "run":
    await commandRun(args)
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
