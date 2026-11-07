import { arr, bool, compile, obj, opt, str, union, unknown } from "@earendil-works/pi-schema"
import type { Patch } from "./layers.ts"

const RowSchema = obj(
  { id: str({ minLength: 1 }), name: str({ minLength: 1 }), config: opt(unknown()), disabled: opt(bool()) },
  { open: true },
)
const InsertSchema = obj({ insert: arr(RowSchema) })
const OverrideSchema = obj({
  id: str({ minLength: 1 }),
  name: opt(str({ minLength: 1 })),
  config: opt(unknown()),
  disabled: opt(bool()),
})
const PatchSchema = union([InsertSchema, OverrideSchema])
const patchCheck = compile(PatchSchema)

export const PatchArg = PatchSchema

const OWNER_PATCH = "plugins.patch"

const isPatch = (value: unknown): value is Patch => patchCheck.check(value)

export function parseProfilePatch(value: unknown): Patch[] {
  if (!Array.isArray(value)) throw new Error("xin.profile.json patch must be a list")
  return value.map((patch, index) => {
    if (!isPatch(patch)) throw new Error(`xin.profile.json patch ${index} is not a row patch`)
    return patch
  })
}

export function parseOwnerPatch(value: unknown, warn: (message: string) => void): Patch[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warn("stored owner patch is not a list; ignored")
    return []
  }
  return value.filter((patch, index) => {
    if (isPatch(patch)) return true
    warn(`stored owner patch ${index} is not a row patch; ignored`)
    return false
  })
}

export function readOwnerPatch(storage: DurableObjectStorage, warn: (message: string) => void): Patch[] {
  return parseOwnerPatch(storage.kv.get(OWNER_PATCH), warn)
}

export function writeOwnerPatch(storage: DurableObjectStorage, patch: readonly Patch[]): void {
  if (patch.length === 0) storage.kv.delete(OWNER_PATCH)
  else storage.kv.put(OWNER_PATCH, patch)
}
