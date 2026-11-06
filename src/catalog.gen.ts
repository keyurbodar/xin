import * as p0 from "../plugins/time/index.ts"
import type { Row } from "./kernel/layers.ts"
import type { Catalog } from "./kernel/loader.ts"

export const CATALOG: Catalog = {
  time: {
    plugin: p0,
    title: "Current time",
    description: "A current_time tool in a configurable timezone.",
    source: "xin-plugin-time@0.1.0",
  },
}

export const BUNDLES: Readonly<Record<string, readonly Row[]>> = {
  "xin-plugin-time": [{ id: "time", name: "cordis:time", config: { timezone: "UTC" } }],
}
