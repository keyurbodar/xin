// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { describe, expect, it } from "vitest"
import { check, children } from "./check.ts"
import { seedFor, Visual } from "./lua.ts"
import type { Node } from "./node.ts"

function textOf(node: Node): string {
  if (node.kind === "text") return node.spans.map((span) => span.text).join("")
  return children(node).map(textOf).join("|")
}

function find(node: Node, kind: Node["kind"]): Node | undefined {
  if (node.kind === kind) return node
  for (const child of children(node)) {
    const found = find(child, kind)
    if (found !== undefined) return found
  }
  return undefined
}

const failure = (script: string): string => {
  try {
    check(script, 1)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`expected ${script} to fail`)
}

describe("visual runtime", () => {
  it("renders a view, and handlers change its state", () => {
    const visual = Visual.load(
      `local s = ui.state { tab = "p95" }
      return function()
        return ui.column { gap = 12,
          ui.text { "Latency ", ui.span { s.tab, weight = 600, color = "accent" }, size = "lg" },
          ui.tabs { options = { "p95", "p99" }, value = s.tab, on_change = function(v) s.tab = v end },
        }
      end`,
      1,
    )
    const tree = visual.render()
    expect(textOf(tree)).toBe("Latency p95|")
    const tabs = find(tree, "tabs")
    if (tabs?.kind !== "tabs") throw new Error("no tabs")
    visual.call(tabs.onChange, { kind: "text", value: "p99" })
    expect(textOf(visual.render())).toBe("Latency p99|")
  })

  it("accepts a script that returns a static node", () => {
    expect(textOf(Visual.load(`return ui.text "hello"`, 1).render())).toBe("hello")
  })

  it("enforces the style rules with reasons", () => {
    for (const [script, needle] of [
      [`return ui.text { "x", color = "#ff0000" }`, "theme tokens"],
      [`return ui.column { background = "accent" }`, "no containers"],
      [`return ui.text { "x", font = "Comic Sans" }`, "interface font"],
      [`return ui.text { "x", size = "40px" }`, "type scale"],
      [`return ui.row { colour = "x" }`, "has no 'colour'"],
      [`return ui.chart { type = "pie", series = {} }`, "ui.canvas"],
      [`return ui.canvas { draw = function() end }`, "needs height"],
    ] as const)
      expect(failure(script)).toContain(needle)
  })

  it("stops a runaway script with a budget error instead of hanging", () => {
    expect(failure("while true do end")).toContain("time budget")
    expect(failure("return function() local n = 0 while true do n = n + 1 end end")).toContain("time budget")
  })

  it("has no I/O: the file, load and os functions are gone", () => {
    for (const name of ["io", "os", "require", "dofile", "loadfile", "load", "debug", "package"])
      expect(textOf(Visual.load(`return ui.text { tostring(${name}) }`, 1).render())).toBe("nil")
    expect(failure(`local s = string.rep("x", 1e8)`)).toContain("over 1 MB")
  })

  it("seeds math.random from the visual's id, so every render draws the same data", () => {
    const script = `return function() return ui.text { tostring(math.random(1, 1000000)) } end`
    const first = textOf(Visual.load(script, seedFor("call-a")).render())
    expect(textOf(Visual.load(script, seedFor("call-a")).render())).toBe(first)
    expect(textOf(Visual.load(script, seedFor("call-b")).render())).not.toBe(first)
  })

  it("exercises every control and reports the first failure with where it happened", () => {
    const report = check(
      `local s = ui.state { on = false, n = 1 }
      return function()
        return ui.column {
          ui.toggle { label = "Log scale", value = s.on, on_change = function(v) s.on = v end },
          ui.slider { label = "n", value = s.n, min = 1, max = 10, on_change = function(v) s.n = v end },
          ui.button { label = "Reset", on_click = function() s.n = 1 end },
        }
      end`,
      1,
    )
    expect(report.interactions).toBe(4)
    expect(
      failure(`local s = ui.state { x = 1 }
      return function()
        return ui.button { label = "Break", on_click = function() s.x = nil end }, ui.text { s.x + 1 }
      end`),
    ).toContain("after pressing 'Break'")
  })

  it("runs canvas draws and records vector commands", () => {
    const visual = Visual.load(
      `return ui.canvas { height = 100, draw = function(g, w, h)
        g:rect(0, 0, w, h, { stroke = "border", radius = 4 })
        g:text(4, 4, ui.fmt(1234.5, { unit = "ms" }))
        if g.pointer then g:circle(g.pointer.x, g.pointer.y, 3, { fill = "accent" }) end
      end }`,
      1,
    )
    const canvas = visual.render()
    if (canvas.kind !== "canvas") throw new Error("no canvas")
    const drawing = visual.drawCanvas(canvas.draw, 640, 100, 0, { x: 10, y: 10, down: false })
    expect(drawing.readsPointer).toBe(true)
    expect(drawing.commands.map((command) => command.kind)).toEqual(["stroke", "text", "fill"])
    expect(drawing.commands[1]).toMatchObject({ kind: "text", text: "1,235 ms" })
    expect(failure(`return ui.canvas { height = 80, draw = function(g) g:line(0, 0, "x", 1) end }`)).toContain(
      "in a canvas draw",
    )
  })

  it("checks scenes and shaders without a GPU", () => {
    expect(
      check(
        `return ui.scene { height = 240, draw = function(s) s:box { at = { 0, 0, 0 }, size = 1, color = "accent" } end }`,
        1,
      ).nodes,
    ).toBe(1)
    expect(failure(`return ui.scene { height = 240, draw = function(s) end }`)).toContain("no geometry")
    expect(failure(`return ui.shader { height = 200, code = "void main() {}" }`)).toContain("mainImage")
  })

  it("fails a half-written script cleanly, as a stream does before it ends", () => {
    const whole = `return function() return ui.column { ui.text "a", ui.text "b" } end`
    for (const cut of [10, 30, whole.length - 4]) expect(() => Visual.load(whole.slice(0, cut), 1)).toThrow()
    expect(textOf(Visual.load(whole, 1).render())).toBe("a|b")
  })
})
