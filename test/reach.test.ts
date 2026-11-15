import { describe, expect, it } from "vitest"
import { reachViolations } from "../scripts/reach.ts"

const NONE: ReadonlySet<string> = new Set()
const check = (text: string, permitted = NONE): readonly string[] => reachViolations("probe.ts", text, permitted)

describe("the build check on what plugin source reaches", () => {
  it("refuses the routes the runtime guards cannot see", () => {
    expect(check(`ctx.reflect.get("host").env.KEK`)).toEqual([expect.stringContaining("reads ctx.reflect")])
    expect(check(`const g = ctx.get; g("secrets")`)).toEqual([expect.stringContaining("takes ctx.get as a value")])
    expect(check(`ctx.root.secrets.get("x")`)).toEqual([expect.stringContaining("reads ctx.root")])
    expect(check(`ctx.fiber.parent.fiber.ctx`)).toEqual([expect.stringContaining("reads ctx.fiber")])
    expect(check(`await import(["cloudflare", "workers"].join(":"))`)).toEqual([
      expect.stringContaining("computed module name"),
    ])
    expect(check("await import(`cloudflare:workers`)")).toHaveLength(2)
    expect(check(`ctx.get(name)`)).toEqual([expect.stringContaining("computed name")])
    expect(check(`ctx.get("secrets")`)).toEqual([expect.stringContaining("without the secrets permission")])
    expect(check(`const c = ctx; c.get(name)`)).toEqual([expect.stringContaining("aliases ctx")])
    expect(check(`ctx["get"](name)`)).toEqual([expect.stringContaining("computed key")])
    expect(check(`const { get } = ctx; get("host")`)).toEqual([expect.stringContaining("destructures ctx")])
    expect(check(`Reflect.get(ctx.ops, Symbol.for("cordis.original"))`)).toEqual([
      expect.stringContaining("cordis.original"),
    ])
    expect(check(`ctx.ops[symbols.original].ctx`)).toEqual([expect.stringContaining("cordis.original")])
  })

  it("passes what the declared permissions cover", () => {
    expect(check(`ctx.get("secrets"); const m = await import("./local.ts")`, new Set(["secrets"]))).toEqual([])
    expect(check(`import { env } from "cloudflare:workers"`, new Set(["runtime"]))).toEqual([])
  })
})
