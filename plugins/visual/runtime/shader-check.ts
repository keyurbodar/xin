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

export function validateShader(code: string, inputs: readonly string[]): string | undefined {
  if (new TextEncoder().encode(code).length > MAX_SHADER_BYTES) return `a shader is at most ${MAX_SHADER_BYTES} bytes`
  if (!code.includes("mainImage")) return "a shader defines void mainImage(out vec4 fragColor, in vec2 fragCoord)"
  const bad = inputs.find((name) => !validInputName(name))
  if (bad !== undefined) return `ui.shader input '${bad}' is not a usable GLSL name`
  if (inputs.length > MAX_INPUTS) return `ui.shader takes at most ${MAX_INPUTS} inputs`
  return undefined
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
  ]
  const body = code
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
