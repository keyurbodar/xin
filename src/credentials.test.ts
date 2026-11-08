import { describe, expect, it } from "vitest"
import { credentialRefsIn, expandCredentials, type SecretsPort } from "./credentials.ts"

const secrets = (values: Readonly<Record<string, string>>): SecretsPort => ({
  get: (ref) => values[ref],
})

describe("expandCredentials", () => {
  it("leaves text without templates unchanged", () => {
    expect(expandCredentials("Bearer plain-token", secrets({}))).toEqual({ kind: "ok", text: "Bearer plain-token" })
  })

  it("substitutes every credential reference", () => {
    expect(
      expandCredentials(
        "Bearer ${credential:gh.token}/v1 and ${credential:other}",
        secrets({
          "gh.token": "abc",
          other: "def",
        }),
      ),
    ).toEqual({ kind: "ok", text: "Bearer abc/v1 and def" })
  })

  it("names each unset reference once, in template order", () => {
    expect(expandCredentials("${credential:b}/${credential:a}/${credential:b}", secrets({}))).toEqual({
      kind: "missing",
      refs: ["b", "a"],
    })
  })

  it("treats an empty stored value as missing", () => {
    expect(expandCredentials("${credential:gh}", secrets({ gh: "" }))).toEqual({ kind: "missing", refs: ["gh"] })
  })

  it("rejects a ${...} occurrence that is not a credential template", () => {
    expect(() => expandCredentials("${process.env.TOKEN}", secrets({}))).toThrow(/\$\{process\.env\.TOKEN\}/)
  })

  it("reads the references without resolving them", () => {
    expect(credentialRefsIn("x ${credential:a.b-c} y ${credential:d}")).toEqual(["a.b-c", "d"])
  })
})
