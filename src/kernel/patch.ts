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
const patchCheck = compile(union([InsertSchema, OverrideSchema]))

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
