import { afterEach, describe, expect, it, vi } from "vitest"
import { deploy, deployBody, inject, name } from "./deployhook.ts"

type Posted = { readonly url: string; readonly init: RequestInit | undefined }

const secrets = (values: Readonly<Record<string, string>>) => ({ get: (ref: string) => values[ref] })

function serve(status = 204): Posted[] {
  const posted: Posted[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({ url: String(input), init })
    return new Response(null, { status })
  })
  return posted
}

afterEach(() => vi.unstubAllGlobals())

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

  it("resolves credential templates at call time", async () => {
    const posted = serve()
    const result = await deploy(
      {
        url: "https://${credential:hook-host}/build",
        token: "${credential:gh}",
        ref: "release/${credential:branch}",
      },
      secrets({ "hook-host": "hooks.test", gh: "hook-token", branch: "main" }),
      { add: ["xin-plugin-time@0.1.0"], remove: [] },
    )

    expect(result).toEqual({ application: "deploying", detail: "deploy hook answered 204" })
    expect(posted[0]?.url).toBe("https://hooks.test/build")
    expect(new Headers(posted[0]?.init?.headers).get("authorization")).toBe("Bearer hook-token")
    expect(JSON.parse(String(posted[0]?.init?.body))).toEqual({
      ref: "release/main",
      inputs: { packages: JSON.stringify({ add: ["xin-plugin-time@0.1.0"], remove: [] }) },
    })
  })

  it("reports a missing credential without calling the hook", async () => {
    const posted = serve()
    const result = await deploy({ url: "https://hooks.test/build", token: "${credential:gh}" }, secrets({}), {
      add: [],
      remove: [],
    })

    expect(result).toEqual({ application: "failed", detail: expect.stringContaining("waiting-credentials (gh)") })
    expect(posted).toEqual([])
  })

  it("reports an unconfigured URL without calling the hook", async () => {
    const posted = serve()
    const result = await deploy({}, secrets({}), { add: [], remove: [] })

    expect(result).toEqual({ application: "failed", detail: expect.stringContaining("url") })
    expect(posted).toEqual([])
  })
})
