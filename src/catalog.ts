import { Clock } from "./kernel/clock.ts"
import * as db from "./kernel/db.ts"
import { Http } from "./kernel/http.ts"
import type { Row } from "./kernel/layers.ts"
import type { Catalog, CatalogEntry } from "./kernel/loader.ts"
import * as manager from "./kernel/manager.ts"
import * as managerTool from "./kernel/managertool.ts"
import { Ops } from "./kernel/ops.ts"
import { Pi } from "./kernel/pi.ts"
import { Secrets } from "./kernel/secrets.ts"
import * as system from "./kernel/system.ts"
import { Wire } from "./kernel/wire.ts"
import { BUNDLES as INSTALLED_BUNDLES, CATALOG as INSTALLED } from "./catalog.gen.ts"

const core = (plugin: CatalogEntry["plugin"], title: string, description: string): CatalogEntry => ({
  plugin,
  title,
  description,
  required: true,
  source: "xin",
})

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
  "tool-plugins": {
    plugin: managerTool,
    title: "Plugin manager tool",
    description: "The plugin_manager agent tool. Disable to hide it; allowAgent lets it change rows.",
    source: "xin",
  },
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
