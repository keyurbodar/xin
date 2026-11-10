import { CORE_BUNDLES, CORE_CATALOG } from "./kernel/corerows.ts"
import type { Row } from "./kernel/layers.ts"
import type { Catalog } from "./kernel/loader.ts"
import { BUNDLES as INSTALLED_BUNDLES, CATALOG as INSTALLED } from "./catalog.gen.ts"

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
