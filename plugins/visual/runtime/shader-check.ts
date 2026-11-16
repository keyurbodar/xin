// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

export const MAX_INPUTS = 16
export const MAX_SHADER_BYTES = 64 * 1024
export const MAX_BUFFERS = 4

export type Blend = "alpha" | "light" | "opaque"

const RESERVED: ReadonlySet<string> = new Set([
  "iResolution",
  "iTime",
  "iTimeDelta",
  "iFrame",
  "iMouse",
  "iCamera",
  "iChannel0",
  "iChannel1",
  "iChannel2",
  "iChannel3",
  "iChannelResolution",
  "iNoise",
  "iTexture0",
  "iTexture1",
  "iTexture2",
  "iTexture3",
  "main",
  "mainImage",
])

export function validInputName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !name.startsWith("gl_") &&
    !name.startsWith("ingle_") &&
    !name.startsWith("zeron_") &&
    !RESERVED.has(name)
  )
}

/** Make every line break ANGLE honours (\r\n, \r, \v, \f) a \n, then blank out comments, keeping every newline, so neither can hide a loop or a directive from the guard nor shift a line number. */
export function stripComments(code: string): string {
  return code
    .replace(/\r\n?|[\v\f]/g, "\n")
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "))
}

function loopEscape(code: string): string | undefined {
  if (/\\\r?\n/.test(code)) return "shader line continuations (a \\ at the end of a line) are not supported"
  if (code.includes("##")) return "shader token pasting (##) is not supported"
  const macros = code.split("\n").filter((line) => /^\s*#\s*define\b/.test(line))
  if (macros.some((line) => /\b(for|while|do)\b/.test(line)))
    return "a shader #define cannot contain a loop; write the loop out where it runs"
  if (macros.some((line) => /^\s*#\s*define\s+\w+\(/.test(line)))
    return "shader function-like macros (#define NAME(x) ...) are not supported; write a function instead"
  if (macros.some((line) => /[;{}]/.test(line) || !balanced(line)))
    return "a shader #define body can hold only an expression with balanced parentheses"
  if (/\/\*/.test(code)) return "a shader comment is not closed"
  const loop = /\b(for|while)\b/g
  for (let match = loop.exec(code); match !== null; match = loop.exec(code)) {
    const open = code.slice(match.index + match[0].length).search(/\S/) + match.index + match[0].length
    const close = code[open] === "(" ? closing(code, open) : -1
    if (close < 0) return `a shader \`${match[1]}\` must be followed by its own parenthesized header`
    if (/\n[ \t]*#/.test(code.slice(open, close)))
      return "a shader loop header cannot contain preprocessor directives (#if, #else, ...); write it on one branch"
    if (match[1] === "for" && code.slice(open + 1, close).split(";").length !== 3)
      return "a shader for loop header must be written out as (init; condition; step)"
  }
  return undefined
}

function balanced(text: string): boolean {
  let depth = 0
  for (const char of text) {
    if (char === "(") depth += 1
    else if (char === ")") depth -= 1
    if (depth < 0) return false
  }
  return depth === 0
}

export function validateShader(code: string, inputs: readonly string[]): string | undefined {
  if (new TextEncoder().encode(code).length > MAX_SHADER_BYTES) return `a shader is at most ${MAX_SHADER_BYTES} bytes`
  const escape = loopEscape(stripComments(code))
  if (escape !== undefined) return escape
  if (!code.includes("mainImage")) return "a shader defines void mainImage(out vec4 fragColor, in vec2 fragCoord)"
  const bad = inputs.find((name) => !validInputName(name))
  if (bad !== undefined) return `ui.shader input '${bad}' is not a usable GLSL name`
  if (inputs.length > MAX_INPUTS) return `ui.shader takes at most ${MAX_INPUTS} inputs`
  return undefined
}

export const MAX_LOOP_STEPS = 1024

function closing(code: string, open: number): number {
  let depth = 0
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1
    else if (code[index] === ")") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Bound every loop: each `for` and `while` condition also spends one step of a per-pixel allowance, so a hostile loop cannot hang the GPU. Only text is inserted, never lines, so compile errors keep their line numbers. */
export function guardLoops(code: string): string {
  const loop = /\b(for|while)\s*\(/g
  let out = ""
  let from = 0
  for (let match = loop.exec(code); match !== null; match = loop.exec(code)) {
    const open = match.index + match[0].length - 1
    const close = closing(code, open)
    if (close < 0) break
    const inner = code.slice(open + 1, close)
    let header: string
    if (match[1] === "while") header = `(${inner}) && ingle_step()`
    else {
      const [init, test, step] = inner.split(";")
      header = `${init}; (${test?.trim() === "" ? "true" : test}) && ingle_step();${step}`
    }
    out += `${code.slice(from, open + 1)}${header})`
    from = close + 1
    loop.lastIndex = from
  }
  return out + code.slice(from)
}

export function shaderProgram(code: string, inputs: readonly string[]): { source: string; offset: number } {
  const header = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    "precision highp sampler2D;",
    "uniform vec3 iResolution;",
    "uniform float iTime;",
    "uniform float iTimeDelta;",
    "uniform int iFrame;",
    "uniform vec4 iMouse;",
    "uniform vec4 iCamera;",
    "uniform vec3 iChannelResolution[4];",
    "uniform sampler2D iChannel0;",
    "uniform sampler2D iChannel1;",
    "uniform sampler2D iChannel2;",
    "uniform sampler2D iChannel3;",
    "uniform sampler2D iNoise;",
    "uniform vec2 ingle_scale;",
    "uniform int ingle_blend;",
    "out vec4 ingle_color;",
    ...inputs.slice(0, MAX_INPUTS).map((name) => `uniform float ${name};`),
    "int ingle_steps = 0;",
    `bool ingle_step() { ingle_steps += 1; return ingle_steps <= ${MAX_LOOP_STEPS}; }`,
  ]
  const body = guardLoops(stripComments(code))
    .split("\n")
    .map((line) => (/^\s*(precision\s|#version\s)/.test(line) ? "" : line))
    .join("\n")
  const main = [
    "void main() {",
    "  vec4 color = vec4(0.0, 0.0, 0.0, 1.0);",
    "  mainImage(color, gl_FragCoord.xy * ingle_scale);",
    "  if (ingle_blend == 3) { ingle_color = color; return; }",
    "  color = clamp(color, 0.0, 1.0);",
    "  if (ingle_blend == 0) ingle_color = vec4(color.rgb * color.a, color.a);",
    "  else if (ingle_blend == 1) ingle_color = vec4(color.rgb, max(max(color.r, color.g), color.b));",
    "  else ingle_color = vec4(color.rgb, 1.0);",
    "}",
  ]
  return { source: `${header.join("\n")}\n${body}\n${main.join("\n")}\n`, offset: header.length }
}

export function describeCompileError(log: string, offset: number): string {
  const match = /ERROR:\s*\d+:(\d+):\s*(.*)/.exec(log)
  if (match === null) return `shader: ${log.trim() || "failed to compile"}`
  const line = Number(match[1])
  const message = (match[2] ?? "").trim()
  return line > offset ? `shader line ${line - offset}: ${message}` : `shader: ${message}`
}
