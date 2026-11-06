import { defineExtension } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import { describe, expect, it } from "vitest"
import type { PluginId } from "../ids.ts"
import { defineOp } from "../ops.ts"
import {
  definePlugin,
  type HostExtras,
  type Manifest,
  netAllowed,
  type PluginOps,
  pluginHost,
  reconcile,
} from "./host.ts"

const manifest = (
  id: string,
  requires: string[] = [],
  provides: string[] = [],
  net: string[] = [],
): Omit<Manifest, "config"> => ({
  id: id as PluginId,
  version: "0.0.0",
  requires,
  provides,
  permissions: { net, memory: "none", files: "none" },
})
const op = (name: string) => defineOp({ name, args: obj({}), actors: ["owner"], run: async () => null })
const noOps: PluginOps["run"] = async (_key, name) => ({
  kind: "rejected",
  code: "unknown_op",
  message: `no op ${name}`,
})
const extras: HostExtras = { config: {}, run: noOps }
const hostFor = (target: Manifest, fetcher?: typeof fetch) => pluginHost(target, fetcher, extras)

describe("plugin reconcile", () => {
  it("applies plugins in requires/provides order, whatever the list order", () => {
    const order: string[] = []
    const result = reconcile(
      [
        definePlugin(manifest("b", ["cap:x"]), () => (order.push("b"), {})),
        definePlugin(
          manifest("a", [], ["cap:x"]),
          () => (order.push("a"), { extensions: [defineExtension({ name: "a" })] }),
        ),
      ],
      () => true,
      hostFor,
    )
    expect(order).toEqual(["a", "b"])
    expect([...result.states.values()].map((s) => s.kind)).toEqual(["active", "active"])
    expect(result.extensions.map((e) => e.name)).toEqual(["a"])
  })

  it("isolates a failing plugin and blocks only what needs it", () => {
    const result = reconcile(
      [
        definePlugin(manifest("bad", [], ["cap:bad"]), () => {
          throw new Error("boom")
        }),
        definePlugin(manifest("needs-bad", ["cap:bad"]), () => ({})),
        definePlugin(manifest("fine"), () => ({ ops: [op("fine.go")] })),
        definePlugin(manifest("off"), () => ({ ops: [op("off.go")] })),
        definePlugin(manifest("clash"), () => ({ ops: [op("fine.go")] })),
      ],
      (id) => id !== "off",
      hostFor,
    )
    expect(Object.fromEntries(result.states)).toEqual({
      bad: { kind: "failed", error: "boom" },
      "needs-bad": { kind: "blocked", missing: ["cap:bad"] },
      fine: { kind: "active" },
      off: { kind: "disabled" },
      clash: { kind: "failed", error: "op fine.go is already provided" },
    })
    expect([...result.ops.keys()]).toEqual(["fine.go"])
  })

  it("limits the host fetch to the net permission", async () => {
    expect(netAllowed(["*.example.com"], new URL("https://api.example.com/x"))).toBe(true)
    expect(netAllowed(["example.com"], new URL("https://evil.com"))).toBe(false)
    const fetched: string[] = []
    const fake: typeof fetch = async (input) => (fetched.push(String(input)), new Response("ok"))
    const host = hostFor(manifest("p", [], [], ["example.com"]), fake)
    await expect(host.fetch("https://evil.com/")).rejects.toThrow("no net permission for evil.com")
    expect(await (await host.fetch("https://example.com/")).text()).toBe("ok")
    expect(fetched).toEqual(["https://example.com/"])
  })

  it("refuses a redirect to a host outside the net permission", async () => {
    const fetched: string[] = []
    const fake: typeof fetch = async (input) => {
      const url = String(input)
      fetched.push(url)
      return url === "https://example.com/"
        ? new Response(null, { status: 302, headers: { location: "https://evil.com/x" } })
        : new Response("ok")
    }
    const host = hostFor(manifest("p", [], [], ["example.com"]), fake)
    await expect(host.fetch("https://example.com/")).rejects.toThrow("no net permission for evil.com")
    expect(fetched).toEqual(["https://example.com/"])
  })

  it("follows a redirect that stays inside the net permission", async () => {
    const fetched: string[] = []
    const fake: typeof fetch = async (input) => {
      const url = String(input)
      fetched.push(url)
      return url === "https://example.com/"
        ? new Response(null, { status: 301, headers: { location: "/next" } })
        : new Response("ok")
    }
    const host = hostFor(manifest("p", [], [], ["example.com"]), fake)
    expect(await (await host.fetch("https://example.com/")).text()).toBe("ok")
    expect(fetched).toEqual(["https://example.com/", "https://example.com/next"])
  })
})
