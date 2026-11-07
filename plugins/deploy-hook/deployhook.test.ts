import { describe, expect, it } from "vitest"
import { deployBody, inject, name } from "./deployhook.ts"

describe("deploy hook", () => {
  it("declares the deployer row and posts the ref with the pending packages as a workflow input", () => {
    expect(name).toBe("deploy-hook")
    expect(inject).toEqual(["secrets"])
    expect(JSON.parse(deployBody(undefined, { add: ["left-pad@1.3.0"], remove: ["xin-plugin-time"] }))).toEqual({
      ref: "main",
      inputs: { packages: JSON.stringify({ add: ["left-pad@1.3.0"], remove: ["xin-plugin-time"] }) },
    })
    expect(JSON.parse(deployBody("release", { add: [], remove: [] }))).toEqual({
      ref: "release",
      inputs: { packages: JSON.stringify({ add: [], remove: [] }) },
    })
  })
})
