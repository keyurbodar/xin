import * as failures from "./failures.ts"
import * as files from "./files.ts"
import * as gateway from "./gateway.ts"
import * as jobs from "./jobs.ts"
import { hostModule } from "./kernel/hostmodule.ts"
import { Clock } from "./kernel/clock.ts"
import * as db from "./kernel/db.ts"
import * as deployHook from "./kernel/deployhook.ts"
import { Http } from "./kernel/http.ts"
import type { Row } from "./kernel/layers.ts"
import type { Catalog, CatalogEntry } from "./kernel/loader.ts"
import * as manager from "./kernel/manager.ts"
import { Ops } from "./kernel/ops.ts"
import { Pi } from "./kernel/pi.ts"
import { Secrets } from "./kernel/secrets.ts"
import * as system from "./kernel/system.ts"
import { Wire } from "./kernel/wire.ts"
import * as mcp from "./mcp.ts"
import * as memory from "./memory.ts"
import type { HostModule, ModuleDeps } from "./module.ts"
import * as models from "./models.ts"
import * as orchestrator from "./orchestrator.ts"
import * as push from "./push.ts"
import * as questions from "./questions.ts"
import * as schedules from "./schedules.ts"
import * as skills from "./skills.ts"
import * as watchdog from "./watchdog.ts"
import * as workspace from "./workspace.ts"
import { BUNDLES as INSTALLED_BUNDLES, CATALOG as INSTALLED } from "./catalog.gen.ts"

const core = (plugin: CatalogEntry["plugin"], title: string, description: string): CatalogEntry => ({
  plugin,
  title,
  description,
  required: true,
  source: "xin",
})

const feature = (
  name: string,
  create: (deps: ModuleDeps) => HostModule,
  title: string,
  description: string,
): CatalogEntry => ({ plugin: hostModule(name, create), title, description, source: "xin" })

export const CORE_CATALOG: Catalog = {
  db: core(db, "Database", "The Home SQLite database and host migrations."),
  clock: core(Clock, "Clock", "The single Durable Object alarm: heartbeat, pi wakes and plugin timers."),
  pi: core(Pi, "pi-durable", "The pi registry and Harness. Plugins install any pi extension through it."),
  ops: core(Ops, "Ops", "Commands with receipts and the ops/before policy waterfall."),
  http: core(Http, "HTTP", "Routes inside the Home Durable Object."),
  wire: core(Wire, "Wire", "The web socket protocol, home stream and /v1/cmd."),
  secrets: core(Secrets, "Secrets", "Sealed per-plugin secrets and tool-output redaction."),
  plugins: core(manager, "Plugin manager", "List, enable, configure, insert and remove plugin rows."),
  system: core(system, "System", "Version, restart and update."),
  "deploy-hook": {
    plugin: deployHook,
    title: "Deploy hook",
    description: "Deploys a new build by POSTing to a configured hook URL.",
    source: "xin",
  },
  models: feature("models", models.create, "Models", "Run-time model catalog, credentials and set_model."),
  files: feature("files", files.create, "Files", "R2-backed read, write and edit for pi's file tools."),
  intake: feature("intake", gateway.create, "Intake", "Inbound debounce, batch claim and dispatch."),
  memory: feature("memory", memory.create, "Memory", "Notes with FTS recall and the Dreamer."),
  push: feature("push", push.create, "Web Push", "Encrypted pushes when no tab is open."),
  skills: feature("skills", skills.create, "Skills", "Markdown skills loaded on demand."),
  mcp: feature("mcp", mcp.create, "MCP", "MCP servers as deferred tools."),
  workspace: feature("workspace", workspace.create, "Workspace", "Projects and thread documents."),
  schedules: feature("schedules", schedules.create, "Schedules", "RRULE and one-shot schedules."),
  orchestrator: feature("orchestrator", orchestrator.create, "Orchestrator", "Coordinator tools and threads."),
  jobs: feature("jobs", jobs.create, "Jobs", "Slow tools as jobs that report back."),
  questions: feature("questions", questions.create, "Questions", "ask_user and pending requests."),
  watchdog: feature("watchdog", watchdog.create, "Watchdog", "Fails stalled threads and overdue jobs."),
  failures: feature("failures", failures.create, "Failures", "Run failures as visible entries."),
}

const row = (id: string): Row => ({ id, name: `cordis:${id}` })

export const CORE_BUNDLES: Readonly<Record<string, readonly Row[]>> = {
  "xin-base": Object.keys(CORE_CATALOG).map(row),
}

const corePlugins = new Set(Object.keys(CORE_CATALOG))
const pluginClash = Object.keys(INSTALLED).find((name) => corePlugins.has(name))
if (pluginClash !== undefined)
  throw new Error(`generated catalog declares plugin "${pluginClash}", which is a core catalog entry`)

const coreBundles = new Set(Object.keys(CORE_BUNDLES))
const bundleClash = Object.keys(INSTALLED_BUNDLES).find((name) => coreBundles.has(name))
if (bundleClash !== undefined)
  throw new Error(`generated catalog declares bundle "${bundleClash}", which is a core bundle`)

const coreRows = new Set(Object.values(CORE_BUNDLES).flatMap((rows) => rows.map((entry) => entry.id)))
for (const [pkg, rows] of Object.entries(INSTALLED_BUNDLES))
  for (const installed of rows)
    if (coreRows.has(installed.id))
      throw new Error(`generated bundle "${pkg}" declares row "${installed.id}", which a core bundle already uses`)

export const CATALOG: Catalog = { ...CORE_CATALOG, ...INSTALLED }
export const BUNDLES: Readonly<Record<string, readonly Row[]>> = { ...CORE_BUNDLES, ...INSTALLED_BUNDLES }
