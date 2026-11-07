import type { JsonValue } from "@earendil-works/chord"
import { bool, obj, opt, unknown } from "@earendil-works/pi-schema"
import { OpRejected } from "../ops.ts"
import { FragmentId, isFragment, isRuntimeRowId } from "../rowid.ts"
import { configSchemaOf, validateConfig } from "./config.ts"
import type { Catalog } from "./loader.ts"

export type BundlePatch = {
  readonly id: string
  readonly config?: JsonValue
  readonly disabled?: boolean
}

export type BundlePatchState = { readonly id: string; readonly state: "applied" | "unknown" }

export type PatchInput = {
  readonly id: string
  readonly config?: JsonValue | null | undefined
  readonly disabled?: boolean | null | undefined
}

export const BundlePatchArg = obj({
  id: FragmentId,
  config: opt(unknown()),
  disabled: opt(bool()),
})

export function normalizePatch(entry: PatchInput): BundlePatch {
  return {
    id: entry.id,
    ...(entry.config === undefined || entry.config === null ? {} : { config: entry.config }),
    ...(entry.disabled === undefined || entry.disabled === null ? {} : { disabled: entry.disabled }),
  }
}

export const patchStates = (
  patches: readonly BundlePatch[],
  applied: (id: string) => boolean,
): readonly BundlePatchState[] =>
  patches.map((entry) => ({ id: entry.id, state: applied(entry.id) ? "applied" : "unknown" }))

export function validatePatches(
  pkg: string,
  patches: readonly BundlePatch[],
  pluginAt: (id: string) => string | undefined,
  catalog: Catalog,
): void {
  for (const entry of patches) {
    if (!isFragment(entry.id)) fail(`bundle ${pkg} patch id ${entry.id} is invalid`)
    if (isRuntimeRowId(entry.id)) fail(`bundle ${pkg} cannot patch runtime row ${entry.id}`)
    const plugin = pluginAt(entry.id)
    if (plugin === undefined) continue
    const target = catalog[plugin]
    if (target?.required === true) fail(`row ${entry.id} is required and cannot be patched by a bundle`)
    if (entry.config === undefined) continue
    const schema = configSchemaOf(target?.plugin)
    if (schema !== undefined) validateConfig(plugin, schema, entry.config)
  }
}

function fail(message: string): never {
  throw new OpRejected("bad_args", message)
}
