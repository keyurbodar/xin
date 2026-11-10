import type { Row } from "./layers.ts"
import type { Catalog, CatalogEntry } from "./loader.ts"
import { Clock } from "./clock.ts"
import * as db from "./db.ts"
import { Http } from "./http.ts"
import * as manager from "./manager.ts"
import * as managerTool from "./managertool.ts"
import { Ops } from "./ops.ts"
import * as packages from "./packages.ts"
import { Pi } from "./pi.ts"
import { Secrets } from "./secrets.ts"
import * as system from "./system.ts"
import { Wire } from "./wire.ts"

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
  secrets: core(Secrets, "Credentials", "Named credentials sealed with the KEK, and tool-output redaction."),
  plugins: core(manager, "Plugin manager", "List, enable and configure plugin rows."),
  packages: core(packages, "Packages", "The build's packages, pending installs and the boot reconcile."),
  system: core(system, "System", "Version, restart and update."),
  "tool-plugins": {
    plugin: managerTool,
    title: "Plugin manager tool",
    description: "The plugin_manager agent tool, off by default.",
    source: "xin",
  },
}

const DISABLED_BY_DEFAULT = new Set(["tool-plugins"])

const row = (id: string): Row => ({
  id,
  name: `cordis:${id}`,
  ...(DISABLED_BY_DEFAULT.has(id) ? { disabled: true } : {}),
})

export const CORE_BUNDLES: Readonly<Record<string, readonly Row[]>> = {
  "xin-base": Object.keys(CORE_CATALOG).map(row),
}
