// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { describe, expect, it } from "vitest"
import { check, children } from "./check.ts"
import { seedFor, Visual } from "./lua.ts"
import { guardLoops, MAX_LOOP_STEPS, shaderProgram, stripComments } from "./shader-check.ts"
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

const UPVALUES = Array.from({ length: 190 }, (_, index) => "v" + index)
const CLOSURE_CHAIN =
  "local f while true do local " +
  UPVALUES.join(", ") +
  " = " +
  UPVALUES.map(() => "1").join(", ") +
  " local g = f f = function() return g, " +
  UPVALUES.join(" + ") +
  " end end"

const spread = (body: string): string =>
  `local a = {} for i = 1, 5000 do a[i] = 65 end local function run(...) for i = 1, 1e5 do ${body} end end run(table.unpack(a))`

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

  it("keeps the budget error raised through pcall and xpcall", () => {
    expect(failure("while true do pcall(function() while true do end end) end")).toContain("time budget")
    expect(failure("while true do xpcall(function() while true do end end, function() end) end")).toContain(
      "time budget",
    )
    expect(failure("return function() while true do pcall(pcall, function() while true do end end) end end")).toContain(
      "time budget",
    )
    expect(failure(`xpcall(function() error("x") end, function(e) while true do end end)`)).toContain("time budget")
    expect(failure(`xpcall(function() while true do end end, function(e) while true do end end)`)).toContain(
      "time budget",
    )
    expect(
      textOf(Visual.load(`return ui.text { select(2, xpcall(error, function(e) return "handled" end)) }`, 1).render()),
    ).toBe("handled")
  })

  it("bounds memory: string doubling, text churn and table fills stop with a reason", () => {
    expect(failure(`local s = "x" while true do s = s .. s end`)).toContain("over 1 MB")
    expect(failure(`local t = {} for i = 1, 1e7 do t[i] = i end`)).toContain("too many entries")
    expect(failure(`local t = {} for i = 1, 1e7 do t["k" .. i] = true end`)).toContain("too much text")
    expect(failure(`local t = {} local s = string.rep("x", 1 << 19) for i = 1, 1e4 do t[i] = s .. i end`)).toContain(
      "table.concat",
    )
    expect(failure(`local s = "x" while true do pcall(function() s = s .. s end) end`)).toContain("over 1 MB")
    expect(
      failure(`local big = string.rep("x", 1 << 20) local t = {} for i = 1, 3000 do t[i] = big:sub(2) end`),
    ).toContain("too much text")
    expect(failure(`local s = string.rep("x", 1100) local r = s:gsub("x", s)`)).toContain("over 1 MB")
    expect(failure(`for i = 1, 1e7 do _G["k" .. i] = true end`)).toContain("too much text")
    expect(failure("local t = {} while true do t = setmetatable({}, t) end")).toContain("too many tables")
    expect(failure("local t = {} for i = 1, 1e7 do t[i] = tostring(i) end")).toContain("too much text")
    expect(failure('local t = {} for i = 1, 1e7 do t[i] = "k" .. i end')).toContain("too much text")
    expect(failure(CLOSURE_CHAIN)).toContain("too many tables or functions")
    expect(failure(`local function f(n) return f(n + 1) + 1 end f(1)`)).toContain("too deeply")
    expect(failure(`local t = table.unpack({}, 1, 5e5)`)).toContain("too deeply")
  }, 30_000)

  it("counts native loops against the time budget, which the instruction hook cannot see", () => {
    expect(failure(spread('local _ = select("#", ...)'))).toContain("time budget")
    expect(failure(`local function f(...) return ... end ${spread("local _ = f(...)")}`)).toContain("time budget")
    expect(failure(spread("local _ = utf8.char(...)"))).toMatch(/time budget|too much text/)
    expect(failure(`local f = string.rep("b", 2e4) for i = 1, 1e4 do string.packsize(f) end`)).toContain("time budget")
    expect(
      failure(`local f, s = string.rep("x", 2e4), string.rep("a", 2e4) for i = 1, 1e4 do string.unpack(f, s) end`),
    ).toContain("time budget")
    expect(
      failure(`local t = {} for i = 1, 5e4 do t[i] = (i * 7919) % 50000 end for i = 1, 1e3 do table.sort(t) end`),
    ).toContain("time budget")
    expect(failure(`for i = 1, 3 do string.rep("", 1e9) end`)).toContain("time budget")
    expect(failure(`string.find(string.rep("a", 3000), ".-.-.-b")`)).toContain("time budget")
    expect(failure(`string.find(string.rep("a", 1 << 19), "[" .. string.rep("b", 9000) .. "a]c")`)).toContain(
      "time budget",
    )
    expect(failure(`local s = string.rep("a", 1 << 19) for i = 1, 1e6 do s:find("b", 1, true) end`)).toContain(
      "time budget",
    )
    expect(
      failure(
        `local a, b = string.rep("a", 1 << 19), string.rep("a", 1 << 19) for i = 1, 1e6 do local _ = a == b or a < b end`,
      ),
    ).toContain("time budget")
    expect(failure(`local s = string.rep("a", 1 << 19) for i = 1, 1e6 do utf8.len(s) end`)).toContain("time budget")
    expect(failure(`table.move({}, 1, 1e9, 2)`)).toContain("time budget")
    expect(
      textOf(
        Visual.load(
          `return ui.text { tostring(tonumber(string.rep("1", 300))) .. tostring(tonumber("12")) }`,
          1,
        ).render(),
      ),
    ).toBe("nil12")
    expect(
      failure(
        `local t = {} for i = 1, 1999 do t = setmetatable({}, { __index = t }) end for i = 1, 1e6 do local _ = t.x end`,
      ),
    ).toContain("time budget")
    expect(
      failure(
        `local t = {} for i = 1, 1999 do t = setmetatable({}, { __newindex = t }) end for i = 1, 1e6 do t.x = nil end`,
      ),
    ).toContain("time budget")
    expect(
      failure(
        `local t = {} for i = 1, 5e4 do t[i] = i end for i = 1, 1e3 do table.sort(t, function(a, b) return a > b end) end`,
      ),
    ).toContain("time budget")
    expect(
      failure(`local t = {} for i = 1, 3e4 do t[i] = i end for i = 1, 1e4 do local _ = table.unpack(t) end`),
    ).toContain("time budget")
    expect(failure(`local s = string.rep("a", 3e4) for i = 1, 1e4 do local _ = s:byte(1, -1) end`)).toContain(
      "time budget",
    )
    expect(
      failure(`local s = string.rep("a", 3e4) for i = 1, 1e4 do local _ = utf8.codepoint(s, 1, -1) end`),
    ).toContain("time budget")
    expect(
      failure(`local t = {} for i = 1, 5e4 do t[i] = i end for i = 1, 1e4 do table.insert(t, 1, i) end`),
    ).toContain("time budget")
  }, 30_000)

  it("counts memory across the whole check, since every call shares one state", () => {
    const buttons = Array.from(
      { length: 24 },
      (_, index) =>
        `ui.button { label = "b${index}", on_click = function() for i = 1, 30 do keep[#keep + 1] = big:sub(i) end end }`,
    ).join(",\n")
    expect(
      failure(`keep = {}
      big = string.rep("x", 1 << 20)
      return function() return ui.column { ${buttons} } end`),
    ).toContain("too much text")
  })

  it("starts each call with a fresh allowance", () => {
    const visual = Visual.load(
      `local n = 0
      return function()
        local t = {}
        for i = 1, 90000 do t[i] = i end
        n = n + 1
        return ui.text { tostring(n) }
      end`,
      1,
    )
    expect(textOf(visual.render())).toBe("1")
    expect(textOf(visual.render())).toBe("2")
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

const shader = (body: string): string =>
  failure(`return ui.shader { height = 200, code = [[void mainImage(out vec4 c, in vec2 p) {
${body}
c = vec4(1.0); }]] }`)

describe("shader loop guard", () => {
  it("refuses forms that would hide a loop from the guard", () => {
    expect(shader("#define LOOP for\nLOOP (int i = 0; i < 9; i++) {}")).toContain("#define cannot contain a loop")
    expect(shader("#define F(x) for(x)\nF(int i = 0; i < 9; i++) {}")).toContain("#define cannot contain a loop")
    expect(shader("#define W wh ## ile\n")).toContain("token pasting")
    expect(shader("#define L \\\nfor\n")).toContain("line continuations")
    expect(shader("#define ID(x) x\nID(for) (int i = 0; i < 9; i++) {}")).toContain("function-like macros")
    expect(shader("#define OPEN (\nfor OPEN int i = 0; i < 9; i++) {}")).toContain("balanced parentheses")
    expect(shader("#define C 1 > 0) || (true\nwhile (C) {}")).toContain("balanced parentheses")
    expect(shader("#define S ;\nfor (int i = 0 S i < 9 S i++) {}")).toContain("balanced parentheses")
    expect(shader("#define A B\n#define B 1\nint i = 0; while A {}")).toContain("parenthesized header")
    expect(shader("for (int i = 0; i < 9) {}")).toContain("(init; condition; step)")
    expect(shader("for (\n#if 0\n;;)\n#else\nint i = 0; i < 9; i++)\n#endif\n{}")).toContain("preprocessor directives")
    expect(shader("while (\n#ifdef X\nfalse\n#else\ntrue\n#endif\n) {}")).toContain("preprocessor directives")
    for (const lineBreak of ["\r", "\v", "\f", "\r\n"])
      expect(
        shader(
          `for (${lineBreak}#if 0${lineBreak};;)${lineBreak}#else${lineBreak}int i = 0; i < 9; i++)${lineBreak}#endif${lineBreak}{}`,
        ),
      ).toContain("preprocessor directives")
    expect(guardLoops(stripComments("// hidden\rwhile (true) {}"))).toContain("ingle_step()")
    expect(
      check(
        `return ui.shader { height = 200, code = [[#if 1
#define K 2.0
#endif
void mainImage(out vec4 c, in vec2 p) { float t = 0.0; for (int i = 0; i < 9; i++) { t += K; } c = vec4(t); }]] }`,
        1,
      ).nodes,
    ).toBe(1)
    expect(guardLoops(stripComments("for/**/(int i = 0; i < 9; i++) {}"))).toContain("ingle_step()")
  })

  it("adds a step to every loop condition without adding lines", () => {
    const code = [
      "void mainImage(out vec4 c, in vec2 p) {",
      "  float t = 0.0;",
      "  for (int i = 0; i < int(min(8.0, iTime)); i++) { t += 1.0; }",
      "  for (;;) { break; }",
      "  int n = 0;",
      "  while (n < 100000000) { n++; }",
      "  do { n--; } while (n > 0);",
      "  float rainfor = transform(t);",
      "}",
    ].join("\n")
    const guarded = guardLoops(code)
    expect(guarded.split("\n")).toHaveLength(code.split("\n").length)
    expect(guarded).toContain("for (int i = 0; ( i < int(min(8.0, iTime))) && ingle_step(); i++)")
    expect(guarded).toContain("for (; (true) && ingle_step();)")
    expect(guarded).toContain("while ((n < 100000000) && ingle_step())")
    expect(guarded).toContain("while ((n > 0) && ingle_step());")
    expect(guarded).toContain("transform(t)")
    const { source, offset } = shaderProgram(code, [])
    expect(source.split("\n")[offset - 1]).toContain(`ingle_steps <= ${MAX_LOOP_STEPS}`)
  })
})
