import { expect, test } from "bun:test"
import { OpError } from "../lib/api.ts"
import { consentOf } from "./extensions.ts"

const PIN = `sha512-${"A".repeat(86)}==`
const PERMISSIONS = [{ id: "network", title: "Reach the network", why: "guarded declares it" }]

test("a consent request carries the registry pin the market sent", () => {
  expect(consentOf(new OpError("consent_required", "asks", { permissions: PERMISSIONS, integrity: PIN }))).toEqual({
    permissions: PERMISSIONS,
    integrity: PIN,
  })
})

test("a consent request without a well-formed sha512 pin carries none", () => {
  for (const integrity of [undefined, "", `sha256-${"A".repeat(43)}=`, `sha512-${"A".repeat(10)}==`])
    expect(consentOf(new OpError("consent_required", "asks", { permissions: PERMISSIONS, integrity }))?.integrity).toBeUndefined()
})

test("another failure is not a consent request", () => {
  expect(consentOf(new OpError("bad_args", "nope", { integrity: PIN }))).toBeUndefined()
  expect(consentOf(new Error("nope"))).toBeUndefined()
})
