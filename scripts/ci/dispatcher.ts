import { Database } from "bun:sqlite"
import { createHmac, timingSafeEqual } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Instabox, instabox, type Machine } from "./instabox.ts"
import { isVitestFile, type Job, plan, RUNNERS_PER_RUN, TEST_WORKERS, VITEST_INCLUDE } from "./plan.ts"

const REPO = "keyurbodar/xin"
const HOME = process.env.CI_HOME ?? join(process.env.HOME ?? "", "ci")
const PORT = Number(process.env.CI_PORT ?? 8080)
const PUBLIC_URL = process.env.CI_PUBLIC_URL ?? ""
const SELF_MACHINE = process.env.CI_MACHINE_ID ?? ""
const POOL = 10
const RUNNER_SPEC = { vcpus: 8, memMiB: 16384 }
const JOB_TIMEOUT_S = 300
const RUN_TIMEOUT_MS = 8 * 60_000
const STALE_MS = RUN_TIMEOUT_MS + 2 * 60_000
const BUN_VERSION = "1.4.4"
const IMAGE = "xin-runner"
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const USD_PER_S = (RUNNER_SPEC.vcpus * 0.004 + (RUNNER_SPEC.memMiB / 1024) * 0.00225) / 3600
const ROLLUP = "ci"

type Trigger = { readonly sha: string; readonly ref: string; readonly receivedAt: number }
type Outcome = "success" | "failure" | "error"

const env = (name: string) => {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(name + " is not set")
  return value
}

mkdirSync(join(HOME, "logs"), { recursive: true })
const db = new Database(join(HOME, "ci.db"))
db.run("PRAGMA journal_mode = WAL")
db.run(
  "CREATE TABLE IF NOT EXISTS runs (sha TEXT, ref TEXT, tree TEXT, state TEXT, received_at INTEGER, finished_at INTEGER, wall_ms INTEGER, cost_usd REAL, detail TEXT, PRIMARY KEY (sha, received_at))",
)
db.run(
  "CREATE TABLE IF NOT EXISTS jobs (sha TEXT, received_at INTEGER, name TEXT, outcome TEXT, runner TEXT, ms INTEGER, PRIMARY KEY (sha, received_at, name))",
)
db.run("CREATE TABLE IF NOT EXISTS durations (file TEXT PRIMARY KEY, ms REAL)")
db.run("CREATE TABLE IF NOT EXISTS passed (tree TEXT PRIMARY KEY, sha TEXT)")
db.run("CREATE TABLE IF NOT EXISTS pending (sha TEXT, context TEXT, since INTEGER, PRIMARY KEY (sha, context))")

const box: Instabox = instabox(env("INSTABOX_API_KEY"))
const ghToken = env("GH_TOKEN")
const webhookSecret = env("CI_WEBHOOK_SECRET")

async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch("https://api.github.com" + path, {
      method,
      headers: { authorization: "Bearer " + ghToken, accept: "application/vnd.github+json", "user-agent": "xin-ci" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => undefined)
    if (response?.ok) return (await response.json()) as T
    if (attempt >= 3 || (response !== undefined && response.status < 500 && response.status !== 429))
      throw new Error(
        "github " + method + " " + path + ": " + (response?.status ?? "network") + " " + (await response?.text()),
      )
    await Bun.sleep(1000 * 2 ** attempt)
  }
}

const logPath = (sha: string, name: string) => join(HOME, "logs", sha, name + ".log")
const logUrl = (sha: string, name: string) => PUBLIC_URL + "/logs/" + sha + "/" + name
const runUrl = (sha: string) => PUBLIC_URL + "/runs/" + sha
const seconds = (ms: number) => (ms / 1000).toFixed(1) + "s"

async function status(sha: string, context: string, state: "pending" | Outcome, description: string, url: string) {
  if (state === "pending") db.run("INSERT OR REPLACE INTO pending VALUES (?, ?, ?)", [sha, context, Date.now()])
  try {
    await github("POST", "/repos/" + REPO + "/statuses/" + sha, {
      state,
      context: "instabox/" + context,
      description: description.slice(0, 140),
      target_url: url,
    })
    if (state !== "pending") db.run("DELETE FROM pending WHERE sha = ? AND context = ?", [sha, context])
  } catch (error) {
    console.error("status", sha, context, error)
  }
}

async function finalizeOpen(sha: string, description: string) {
  const open = db.query<{ context: string }, [string]>("SELECT context FROM pending WHERE sha = ?").all(sha)
  await Promise.all(open.map((row) => status(sha, row.context, "error", description, runUrl(sha))))
}

async function treeOf(sha: string) {
  const commit = await github<{ tree: { sha: string } }>("GET", "/repos/" + REPO + "/git/commits/" + sha)
  const listing = await github<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
    "GET",
    "/repos/" + REPO + "/git/trees/" + commit.tree.sha + "?recursive=1",
  )
  if (listing.truncated) throw new Error("tree listing truncated")
  return {
    tree: commit.tree.sha,
    paths: listing.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
  }
}

async function includeUnchanged(sha: string): Promise<boolean> {
  const file = await github<{ content: string }>("GET", "/repos/" + REPO + "/contents/vitest.config.ts?ref=" + sha)
  return Buffer.from(file.content, "base64").toString("utf8").includes(VITEST_INCLUDE)
}

const SETUP = [
  "set -eo pipefail",
  '[ "$($HOME/.bun/bin/bun --version 2>/dev/null)" = ' +
    BUN_VERSION +
    " ] || curl -fsSL https://bun.sh/install | bash -s bun-v" +
    BUN_VERSION,
  "export PATH=$HOME/.bun/bin:$PATH",
  "[ -d $HOME/xin/.git ] || git clone -q https://github.com/" + REPO + " $HOME/xin",
  "cd $HOME/xin && bun install --frozen-lockfile",
  "cd web && bun install --frozen-lockfile && (bunx playwright install --with-deps chromium || bunx playwright install chromium)",
].join("\n")

const checkout = (sha: string) =>
  [
    "set -eo pipefail",
    "export PATH=$HOME/.bun/bin:$PATH CI=true",
    'pkill -9 -f "$HOME/xin/" || true',
    "cd $HOME/xin",
    "git fetch -q --depth=1 origin " + sha,
    "git checkout -q -f " + sha,
    "git clean -q -ffdx -e node_modules",
    "h=$(cat bun.lock web/bun.lock | sha256sum | cut -c1-16)",
    'if [ "$(cat $HOME/.lock-hash 2>/dev/null)" != "$h" ]; then bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile) && echo $h > $HOME/.lock-hash; fi',
  ].join("\n")

const jobScript = (job: Job) =>
  [
    "set -o pipefail",
    "export PATH=$HOME/.bun/bin:$PATH CI=true FORCE_COLOR=0 NO_COLOR=1",
    "cd $HOME/xin",
    job.script,
  ].join("\n")

async function stream(machine: string, cmd: string, log: string, signal: AbortSignal): Promise<number> {
  const response = await fetch("https://api.instabox.sh/v1/machines/" + machine + "/exec", {
    method: "POST",
    headers: { "X-API-Key": env("INSTABOX_API_KEY"), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ cmd, timeoutSeconds: JOB_TIMEOUT_S, noHistory: true }),
    signal,
  })
  if (!response.ok || response.body === null) throw new Error("exec " + response.status + " " + (await response.text()))
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const event = /^event: (.*)$/m.exec(frame)?.[1]
      const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "{}") as {
        data?: string
        exitCode?: number
        timedOut?: boolean
      }
      if (event === "stdout" || event === "stderr") appendFileSync(log, data.data ?? "")
      if (event === "exit") {
        if (data.timedOut === true) appendFileSync(log, "\nci: timed out after " + JOB_TIMEOUT_S + "s\n")
        return data.exitCode ?? 1
      }
      if (event === "error") throw new Error("exec error: " + JSON.stringify(data))
    }
  }
  throw new Error("exec stream ended without an exit event")
}

const idle: string[] = []
const busy = new Set<string>()
const queue: (() => void)[] = []

async function pool(): Promise<void> {
  const machines = (await box.list()).filter((machine: Machine) => machine.metadata?.["xin-ci"] === "runner")
  for (const machine of machines) if (!busy.has(machine.id) && !idle.includes(machine.id)) idle.push(machine.id)
  const image = (await box.snapshots()).find((snapshot) => snapshot.name === IMAGE && snapshot.status === "ready")
  if (image === undefined) return
  const missing = POOL - machines.length
  await Promise.all(
    Array.from({ length: Math.max(0, missing) }, async () => {
      const id = await box.create({
        name: "xin-ci-runner-" + crypto.randomUUID().slice(0, 8),
        source: { snapshotId: image.id },
        spec: RUNNER_SPEC,
        metadata: { "xin-ci": "runner" },
        deleteAfterSeconds: 0,
        autoSuspendAfterSeconds: 300,
      })
      idle.push(id)
      queue.shift()?.()
    }),
  )
}

async function lease(count: number, signal: AbortSignal): Promise<string[]> {
  while (idle.length < count) {
    if (signal.aborted) throw new Error("cancelled while queued")
    await new Promise<void>((resolve) => {
      queue.push(resolve)
      setTimeout(resolve, 5000)
    })
  }
  const picked = idle.splice(0, count)
  for (const id of picked) busy.add(id)
  return picked
}

async function retire(id: string, broken: boolean) {
  busy.delete(id)
  if (broken) {
    await box.remove(id).catch(() => undefined)
    void pool().catch((error: unknown) => console.error("pool", error))
    return
  }
  await box.exec(id, 'pkill -9 -f "$HOME/xin/" || true', 30).catch(() => undefined)
  idle.push(id)
  queue.shift()?.()
}

function recordDurations(json: string, planned: readonly string[], wallMs: number) {
  const report = JSON.parse(json) as { testResults: { name: string; startTime: number; endTime: number }[] }
  const ran = report.testResults.map((result) => ({
    file: result.name.replace(/^.*?\/xin\//, ""),
    ms: result.endTime - result.startTime,
  }))
  const missing = planned.filter((file) => !ran.some((result) => result.file === file))
  if (missing.length > 0) throw new Error("planned test files did not run: " + missing.join(", "))
  const scale = wallMs / Math.max(1, ran.reduce((sum, result) => sum + result.ms, 0) / TEST_WORKERS)
  for (const { file, ms } of ran.map((result) => ({ file: result.file, ms: result.ms * scale })))
    db.run("INSERT INTO durations VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET ms = (ms + excluded.ms) / 2", [
      file,
      ms,
    ])
}

type Active = { readonly sha: string; readonly controller: AbortController }
const active = new Map<string, Active>()

async function runSha(trigger: Trigger): Promise<void> {
  const previous = active.get(trigger.ref)
  if (previous?.sha === trigger.sha) return
  previous?.controller.abort()
  const current: Active = { sha: trigger.sha, controller: new AbortController() }
  active.set(trigger.ref, current)
  const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)])
  const selfLease = "run-" + trigger.sha.slice(0, 12)
  if (SELF_MACHINE !== "") void box.lease(SELF_MACHINE, selfLease, RUN_TIMEOUT_MS / 1000).catch(() => undefined)
  mkdirSync(join(HOME, "logs", trigger.sha), { recursive: true })
  db.run("INSERT OR REPLACE INTO runs VALUES (?, ?, '', 'running', ?, NULL, NULL, NULL, '')", [
    trigger.sha,
    trigger.ref,
    trigger.receivedAt,
  ])
  let runners: string[] = []
  const broken = new Set<string>()
  let costUsd = 0
  try {
    await status(trigger.sha, ROLLUP, "pending", "planning", runUrl(trigger.sha))
    const tree = await treeOf(trigger.sha)
    const cached = db.query<{ sha: string }, [string]>("SELECT sha FROM passed WHERE tree = ?").get(tree.tree)
    if (cached !== null) {
      const note = "same tree passed on " + cached.sha.slice(0, 7)
      await status(trigger.sha, ROLLUP, "success", note, runUrl(cached.sha))
      finish(trigger, tree.tree, "cached", Date.now() - trigger.receivedAt, 0, note)
      return
    }
    if (!(await includeUnchanged(trigger.sha)))
      throw new Error("vitest.config.ts include changed; update VITEST_INCLUDE and isVitestFile in scripts/ci/plan.ts")
    const durations = new Map(
      db
        .query<{ file: string; ms: number }, []>("SELECT file, ms FROM durations")
        .all()
        .map((row) => [row.file, row.ms]),
    )
    const layout = plan(tree.paths.filter(isVitestFile), durations)
    const jobs = layout.flatMap((runner) => runner.jobs)
    await Promise.all(
      jobs.map((job) => status(trigger.sha, job.name, "pending", "queued", logUrl(trigger.sha, job.name))),
    )
    await status(
      trigger.sha,
      ROLLUP,
      "pending",
      "running " + jobs.length + " jobs on " + RUNNERS_PER_RUN + " VMs",
      runUrl(trigger.sha),
    )
    runners = await lease(RUNNERS_PER_RUN, signal)
    const results = await Promise.all(
      layout.map(async (runner, index) => {
        const machine = runners[index] ?? ""
        const leased = Date.now()
        const prepare = logPath(trigger.sha, "checkout-" + (index + 1))
        let ready: Error | undefined
        try {
          await box.resume(machine).catch(() => box.start(machine).catch(() => undefined))
          const code = await stream(machine, checkout(trigger.sha), prepare, signal)
          if (code !== 0) throw new Error("checkout exited " + code)
        } catch (error) {
          ready = error instanceof Error ? error : new Error(String(error))
          broken.add(machine)
        }
        const outcomes = await Promise.all(
          runner.jobs.map(async (job) => {
            const log = logPath(trigger.sha, job.name)
            writeFileSync(
              log,
              "ci: " +
                job.name +
                " on " +
                machine +
                " (" +
                RUNNER_SPEC.vcpus +
                " vCPU), ready " +
                seconds(Date.now() - trigger.receivedAt) +
                " after the push\n",
            )
            const started = Date.now()
            let outcome: Outcome = "error"
            try {
              if (ready !== undefined) throw ready
              const code = await stream(machine, jobScript(job), log, signal)
              const shardNumber = job.name.startsWith("test-") ? job.name.slice(5) : ""
              if (code === 0 && job.files !== undefined)
                recordDurations(
                  await box.read(machine, "/data/home/vitest-" + shardNumber + ".json"),
                  job.files,
                  Date.now() - started,
                )
              if (code === 0 && job.name === "bench")
                db.run("INSERT OR REPLACE INTO durations VALUES (?, ?)", ["test/load.bench.ts", Date.now() - started])
              outcome = code === 0 ? "success" : "failure"
            } catch (error) {
              appendFileSync(log, "\nci: " + String(error) + "\n")
            }
            const ms = Date.now() - started
            appendFileSync(log, "\nci: " + outcome + " in " + seconds(ms) + "\n")
            const superseded = current.controller.signal.aborted
            await status(
              trigger.sha,
              job.name,
              outcome,
              superseded ? "cancelled: superseded by a newer push" : outcome + " in " + seconds(ms),
              logUrl(trigger.sha, job.name),
            )
            db.run("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?, ?, ?)", [
              trigger.sha,
              trigger.receivedAt,
              job.name,
              outcome,
              machine,
              ms,
            ])
            return { job, outcome }
          }),
        )
        costUsd += ((Date.now() - leased) / 1000) * USD_PER_S
        return outcomes
      }),
    )
    const flat = results.flat()
    const failed = flat.filter((result) => result.outcome !== "success").map((result) => result.job.name)
    const verdict: Outcome =
      failed.length === 0 ? "success" : flat.some((result) => result.outcome === "failure") ? "failure" : "error"
    const wall = Date.now() - trigger.receivedAt
    const summary =
      failed.length === 0
        ? flat.length + " jobs passed, " + seconds(wall) + " from push"
        : "failed: " + failed.join(", ")
    await status(trigger.sha, ROLLUP, verdict, summary, runUrl(trigger.sha))
    if (verdict === "success") db.run("INSERT OR REPLACE INTO passed VALUES (?, ?)", [tree.tree, trigger.sha])
    finish(trigger, tree.tree, verdict, wall, costUsd, summary)
  } catch (error) {
    appendFileSync(logPath(trigger.sha, "run"), "ci: " + String(error) + "\n")
    finish(trigger, "", "error", Date.now() - trigger.receivedAt, costUsd, String(error))
  } finally {
    await finalizeOpen(
      trigger.sha,
      current.controller.signal.aborted
        ? "cancelled: superseded by a newer push"
        : "run ended without a result; see the run log",
    )
    for (const id of runners) void retire(id, broken.has(id))
    if (active.get(trigger.ref) === current) active.delete(trigger.ref)
    if (SELF_MACHINE !== "") void box.release(SELF_MACHINE, selfLease).catch(() => undefined)
  }
}

function finish(trigger: Trigger, tree: string, state: string, wall: number, cost: number, detail: string) {
  db.run(
    "UPDATE runs SET tree = ?, state = ?, finished_at = ?, wall_ms = ?, cost_usd = ?, detail = ? WHERE sha = ? AND received_at = ?",
    [tree, state, Date.now(), wall, cost, detail, trigger.sha, trigger.receivedAt],
  )
  console.log(JSON.stringify({ sha: trigger.sha, ref: trigger.ref, state, wall_ms: wall, cost_usd: cost }))
}

async function watchdog() {
  const live = new Set([...active.values()].map((run) => run.sha))
  const stale = db
    .query<{ sha: string }, [number]>("SELECT DISTINCT sha FROM pending WHERE since < ?")
    .all(Date.now() - STALE_MS)
  for (const { sha } of stale)
    if (!live.has(sha)) await finalizeOpen(sha, "run died: no result within " + STALE_MS / 60_000 + " min")
}

function verified(body: string, signature: string | null): boolean {
  if (signature === null) return false
  const expected = Buffer.from("sha256=" + createHmac("sha256", webhookSecret).update(body).digest("hex"))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

type PushEvent = { ref: string; after: string; deleted?: boolean }
type PullEvent = {
  action: string
  number: number
  pull_request: { head: { sha: string; repo: { full_name: string } | null }; author_association: string }
}

function triggerOf(event: string | null, payload: unknown, receivedAt: number): Trigger | undefined {
  if (event === "push") {
    const push = payload as PushEvent
    return push.ref === "refs/heads/main" && push.deleted !== true
      ? { sha: push.after, ref: push.ref, receivedAt }
      : undefined
  }
  if (event !== "pull_request") return undefined
  const pull = payload as PullEvent
  if (!["opened", "synchronize", "reopened"].includes(pull.action)) return undefined
  const trusted = pull.pull_request.head.repo?.full_name === REPO || TRUSTED.has(pull.pull_request.author_association)
  return trusted ? { sha: pull.pull_request.head.sha, ref: "pull/" + pull.number, receivedAt } : undefined
}

async function buildImage(sha: string): Promise<string> {
  const log = join(HOME, "logs", "image.log")
  writeFileSync(log, "")
  const machine = await box.create({
    name: "xin-ci-image-" + sha.slice(0, 8),
    source: { templateId: "universal" },
    spec: RUNNER_SPEC,
    metadata: { "xin-ci": "image" },
    deleteAfterSeconds: 1800,
  })
  try {
    const code = await stream(machine, SETUP + "\n" + checkout(sha), log, AbortSignal.timeout(JOB_TIMEOUT_S * 1000))
    if (code !== 0) throw new Error("image setup exited " + code)
    await box.stop(machine)
    const old = (await box.snapshots()).find((snapshot) => snapshot.name === IMAGE)
    if (old !== undefined) await box.removeSnapshot(old.id)
    return await box.snapshot(machine, IMAGE)
  } finally {
    await box.remove(machine).catch(() => undefined)
  }
}

function page(sha: string): string {
  const runs = db
    .query<
      {
        ref: string
        state: string
        wall_ms: number | null
        cost_usd: number | null
        detail: string
        received_at: number
      },
      [string]
    >("SELECT ref, state, wall_ms, cost_usd, detail, received_at FROM runs WHERE sha = ? ORDER BY received_at DESC")
    .all(sha)
  const latest = runs[0]?.received_at ?? 0
  const jobs = db
    .query<{ name: string; outcome: string; ms: number }, [string, number]>(
      "SELECT name, outcome, ms FROM jobs WHERE sha = ? AND received_at = ? ORDER BY name",
    )
    .all(sha, latest)
  return [
    "xin CI on Instabox: " + sha,
    ...runs.map(
      (r) =>
        new Date(r.received_at).toISOString() +
        "  " +
        r.ref +
        "  " +
        r.state +
        "  wall " +
        (r.wall_ms === null ? "-" : seconds(r.wall_ms)) +
        "  cost $" +
        (r.cost_usd ?? 0).toFixed(4) +
        "  " +
        r.detail,
    ),
    "",
    ...jobs.map(
      (j) => j.name.padEnd(12) + j.outcome.padEnd(9) + seconds(j.ms).padStart(8) + "  " + logUrl(sha, j.name),
    ),
  ].join("\n")
}

const authorized = (request: Request) => request.headers.get("authorization") === "Bearer " + webhookSecret

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/github") {
      const receivedAt = Date.now()
      const body = await request.text()
      if (!verified(body, request.headers.get("x-hub-signature-256")))
        return new Response("bad signature", { status: 401 })
      const trigger = triggerOf(request.headers.get("x-github-event"), JSON.parse(body), receivedAt)
      if (trigger !== undefined) void runSha(trigger)
      return new Response(trigger === undefined ? "ignored" : "queued " + trigger.sha)
    }
    if (request.method === "POST" && url.pathname === "/rerun") {
      if (!authorized(request)) return new Response("unauthorized", { status: 401 })
      const { sha, fresh } = (await request.json()) as { sha: string; fresh?: boolean }
      if (!/^[0-9a-f]{40}$/.test(sha)) return new Response("sha must be 40 hex characters", { status: 400 })
      if (fresh === true) db.run("DELETE FROM passed WHERE sha = ?", [sha])
      void runSha({ sha, ref: "rerun/" + sha, receivedAt: Date.now() })
      return new Response("queued " + sha)
    }
    if (request.method === "POST" && url.pathname === "/image") {
      if (!authorized(request)) return new Response("unauthorized", { status: 401 })
      const { sha } = (await request.json()) as { sha: string }
      void buildImage(sha)
        .then(() => pool())
        .catch((error: unknown) => appendFileSync(join(HOME, "logs", "image.log"), "\nci: " + String(error) + "\n"))
      return new Response("building " + IMAGE + " from " + sha)
    }
    if (url.pathname === "/runs.json")
      return Response.json(db.query("SELECT * FROM runs ORDER BY received_at DESC LIMIT 200").all())
    const logs = /^\/logs\/([0-9a-f]{40})\/([a-z0-9-]+)$/.exec(url.pathname)
    if (logs !== null) {
      const file = logPath(logs[1] ?? "", logs[2] ?? "")
      return existsSync(file)
        ? new Response(readFileSync(file), { headers: { "content-type": "text/plain; charset=utf-8" } })
        : new Response("no log", { status: 404 })
    }
    if (url.pathname === "/logs/image")
      return new Response(
        existsSync(join(HOME, "logs", "image.log")) ? readFileSync(join(HOME, "logs", "image.log")) : "no image log",
      )
    const runs = /^\/runs\/([0-9a-f]{40})$/.exec(url.pathname)
    if (runs !== null)
      return new Response(page(runs[1] ?? ""), { headers: { "content-type": "text/plain; charset=utf-8" } })
    if (url.pathname === "/health")
      return Response.json({ ok: true, idle: idle.length, busy: busy.size, active: [...active.keys()] })
    return new Response("not found", { status: 404 })
  },
})

const startup = db.query<{ sha: string }, []>("SELECT DISTINCT sha FROM pending").all()
for (const { sha } of startup) void finalizeOpen(sha, "dispatcher restarted mid-run; push again or rerun")
db.run("UPDATE runs SET state = 'error', detail = 'dispatcher restarted' WHERE state = 'running'")
void pool().catch((error: unknown) => console.error("pool", error))
setInterval(() => void watchdog().catch((error: unknown) => console.error("watchdog", error)), 60_000)
setInterval(() => void pool().catch((error: unknown) => console.error("pool", error)), 5 * 60_000)
console.log("xin-ci listening on " + PORT)
