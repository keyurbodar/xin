import { describe, expect, it } from "vitest"
import { createContributions } from "./contributions.ts"

type Item = { readonly name: string }

const set = () => createContributions<Item>({ key: (item) => item.name, label: (name) => `item "${name}"` })

describe("contributions", () => {
  it("keeps one value per key across sources and views them sorted by key", () => {
    const items = set()
    items.add("row-b", { name: "beta" })
    items.add("row-a", { name: "alpha" })

    expect(items.values()).toEqual([{ name: "alpha" }, { name: "beta" }])
    expect(items.entries()).toEqual([
      { source: "row-a", key: "alpha", value: { name: "alpha" } },
      { source: "row-b", key: "beta", value: { name: "beta" } },
    ])
    expect(items.get("beta")).toEqual({ source: "row-b", key: "beta", value: { name: "beta" } })
  })

  it("throws on a clash and names the source that holds the key", () => {
    const items = set()
    items.add("row-a", { name: "shared" })

    expect(() => items.add("row-b", { name: "shared" })).toThrow('item "shared" is already contributed by row-a')
    expect(items.get("shared")?.source).toBe("row-a")
  })

  it("removes a contribution only through its own disposer", () => {
    const items = set()
    const first = items.add("row-a", { name: "alpha" })
    const second = items.add("row-b", { name: "beta" })

    second()
    expect(items.values()).toEqual([{ name: "alpha" }])

    second()
    expect(items.values()).toEqual([{ name: "alpha" }])

    first()
    expect(items.values()).toEqual([])
  })

  it("lets a source contribute again after its earlier contribution is removed", () => {
    const items = set()
    const first = items.add("row-a", { name: "alpha" })
    first()

    const again = items.add("row-a", { name: "alpha" })
    expect(items.values()).toEqual([{ name: "alpha" }])

    first()
    expect(items.values()).toEqual([{ name: "alpha" }])
    again()
    expect(items.values()).toEqual([])
  })
})
