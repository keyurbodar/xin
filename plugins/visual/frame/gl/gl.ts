// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

export type RGBA = [number, number, number, number]

const colors = new Map<string, RGBA>()
let probe: CanvasRenderingContext2D | null = null

export function cssColor(css: string): RGBA {
  const known = colors.get(css)
  if (known !== undefined) return known
  if (probe === null) {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    probe = canvas.getContext("2d", { willReadFrequently: true })
  }
  if (probe === null) return [0.5, 0.5, 0.5, 1]
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = "#000000"
  probe.fillStyle = css
  probe.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data
  const rgba: RGBA = [r / 255, g / 255, b / 255, a / 255]
  colors.set(css, rgba)
  return rgba
}

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | string {
  const shader = gl.createShader(type)
  if (shader === null) return "could not create a shader"
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true) return shader
  const log = gl.getShaderInfoLog(shader) ?? "failed to compile"
  gl.deleteShader(shader)
  return log
}

export function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram | string {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex)
  if (typeof vs === "string") return vs
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment)
  if (typeof fs === "string") {
    gl.deleteShader(vs)
    return fs
  }
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (gl.getProgramParameter(program, gl.LINK_STATUS) === true) return program
  const log = gl.getProgramInfoLog(program) ?? "failed to link"
  gl.deleteProgram(program)
  return log
}

export function mustLink(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = linkProgram(gl, vertex, fragment)
  if (typeof program === "string") throw new Error(`internal shader failed: ${program}`)
  return program
}

export function uniforms(gl: WebGL2RenderingContext, program: WebGLProgram): Map<string, WebGLUniformLocation> {
  const out = new Map<string, WebGLUniformLocation>()
  const count: unknown = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < (typeof count === "number" ? count : 0); i++) {
    const info = gl.getActiveUniform(program, i)
    if (info === null) continue
    const name = info.name.replace(/\[0\]$/, "")
    const location = gl.getUniformLocation(program, info.name)
    if (location !== null) out.set(name, location)
  }
  return out
}

export function reducedMotion(): boolean {
  return (
    document.documentElement.dataset["motion"] === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

export interface Surface {
  readonly width: number
  readonly height: number
  readonly dpr: number
  readonly visible: boolean
  setHeight(height: number): void
  destroy(): void
}

export function watchSurface(canvas: HTMLCanvasElement, height: number, onChange: () => void): Surface {
  let width = 0
  let pixels = 0
  let shown = true
  let onScreen = false
  canvas.style.display = "block"
  canvas.style.width = "100%"
  canvas.style.height = `${height}px`
  const measure = (cssWidth: number, cssHeight: number, device?: { inlineSize: number; blockSize: number }): void => {
    const dpr = window.devicePixelRatio || 1
    width = Math.max(1, Math.round(device?.inlineSize ?? cssWidth * dpr))
    pixels = Math.max(1, Math.round(device?.blockSize ?? cssHeight * dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== pixels) canvas.height = pixels
    onChange()
  }
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries)
      measure(entry.contentRect.width, entry.contentRect.height, entry.devicePixelContentBoxSize?.[0])
  })
  try {
    resize.observe(canvas, { box: "device-pixel-content-box" })
  } catch {
    resize.observe(canvas)
  }
  const intersect = new IntersectionObserver((entries) => {
    for (const entry of entries) onScreen = entry.isIntersecting
    onChange()
  })
  intersect.observe(canvas)
  const visibility = (): void => {
    shown = document.visibilityState !== "hidden"
    onChange()
  }
  document.addEventListener("visibilitychange", visibility)
  const motion = matchMedia("(prefers-reduced-motion: reduce)")
  motion.addEventListener("change", onChange)
  return {
    get width() {
      return width
    },
    get height() {
      return pixels
    },
    get dpr() {
      return window.devicePixelRatio || 1
    },
    get visible() {
      return shown && onScreen && width > 0
    },
    setHeight(next) {
      canvas.style.height = `${next}px`
    },
    destroy() {
      resize.disconnect()
      intersect.disconnect()
      document.removeEventListener("visibilitychange", visibility)
      motion.removeEventListener("change", onChange)
    },
  }
}

export interface Loop {
  kick(): void
  destroy(): void
}

export function frameLoop(tick: (delta: number) => boolean): Loop {
  let request = 0
  let last: number | undefined
  const frame = (now: number): void => {
    request = 0
    const delta = last === undefined ? 0 : Math.min((now - last) / 1000, 0.1)
    if (tick(delta)) {
      last = now
      request = requestAnimationFrame(frame)
    } else last = undefined
  }
  return {
    kick() {
      if (request === 0) request = requestAnimationFrame(frame)
    },
    destroy() {
      if (request !== 0) cancelAnimationFrame(request)
      request = 0
    },
  }
}

export interface PointerHandlers {
  down(x: number, y: number): void
  drag(dx: number, dy: number, x: number, y: number): void
  up(x: number, y: number, tap: boolean): void
  hover(x: number, y: number): void
  leave(): void
}

export function trackPointer(canvas: HTMLCanvasElement, handlers: PointerHandlers): () => void {
  let active: { id: number; x: number; y: number; startX: number; startY: number } | undefined
  const local = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }
  const down = (event: PointerEvent): void => {
    if (active !== undefined || (event.pointerType === "mouse" && event.button !== 0)) return
    const [x, y] = local(event)
    active = { id: event.pointerId, x, y, startX: x, startY: y }
    canvas.setPointerCapture(event.pointerId)
    handlers.down(x, y)
  }
  const move = (event: PointerEvent): void => {
    const [x, y] = local(event)
    if (active === undefined) {
      if (event.pointerType === "mouse") handlers.hover(x, y)
      return
    }
    if (event.pointerId !== active.id) return
    handlers.drag(x - active.x, y - active.y, x, y)
    active.x = x
    active.y = y
  }
  const up = (event: PointerEvent): void => {
    if (active === undefined || event.pointerId !== active.id) return
    const [x, y] = local(event)
    const tap = Math.hypot(x - active.startX, y - active.startY) < 4 && event.type === "pointerup"
    active = undefined
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    handlers.up(x, y, tap)
  }
  const leave = (): void => {
    if (active === undefined) handlers.leave()
  }
  canvas.addEventListener("pointerdown", down)
  canvas.addEventListener("pointermove", move)
  canvas.addEventListener("pointerup", up)
  canvas.addEventListener("pointercancel", up)
  canvas.addEventListener("pointerleave", leave)
  return () => {
    canvas.removeEventListener("pointerdown", down)
    canvas.removeEventListener("pointermove", move)
    canvas.removeEventListener("pointerup", up)
    canvas.removeEventListener("pointercancel", up)
    canvas.removeEventListener("pointerleave", leave)
  }
}

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
vec4 tap(vec2 offset) {
  vec4 c = texture(uSource, vUv + offset * uStep);
  if (uThreshold <= 0.0) return c;
  float bright = max(max(c.r, c.g), c.b);
  return c * smoothstep(uThreshold, 1.0, bright);
}
void main() {
  vec4 sum = tap(vec2(0.0)) * 0.227;
  sum += (tap(vec2(1.385)) + tap(vec2(-1.385))) * 0.316;
  sum += (tap(vec2(3.231)) + tap(vec2(-3.231))) * 0.070;
  outColor = sum;
}`

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform float uStrength;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uSource, vUv).rgb * uStrength;
  outColor = vec4(c, clamp(max(max(c.r, c.g), c.b), 0.0, 1.0));
}`

interface Target {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
}

export class Bloom {
  private readonly blur: WebGLProgram
  private readonly composite: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly targets: [Target, Target]
  private readonly depth: WebGLRenderbuffer
  private width = 0
  private height = 0

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.blur = mustLink(gl, FULLSCREEN_VS, BLUR_FS)
    this.composite = mustLink(gl, FULLSCREEN_VS, COMPOSITE_FS)
    this.vao = gl.createVertexArray()
    this.depth = gl.createRenderbuffer()
    this.targets = [this.target(), this.target()]
  }

  private target(): Target {
    const gl = this.gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const framebuffer = gl.createFramebuffer()
    return { texture, framebuffer }
  }

  get size(): [number, number] {
    return [this.width, this.height]
  }

  begin(fullWidth: number, fullHeight: number): void {
    const gl = this.gl
    const width = Math.max(1, Math.ceil(fullWidth / 4))
    const height = Math.max(1, Math.ceil(fullHeight / 4))
    if (width !== this.width || height !== this.height) {
      this.width = width
      this.height = height
      for (const target of this.targets) {
        gl.bindTexture(gl.TEXTURE_2D, target.texture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0)
      }
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].framebuffer)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].framebuffer)
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  }

  finish(strength: number, threshold: number, fullWidth: number, fullHeight: number): void {
    const gl = this.gl
    const [a, b] = this.targets
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.vao)
    gl.useProgram(this.blur)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(gl.getUniformLocation(this.blur, "uSource"), 0)
    const step = gl.getUniformLocation(this.blur, "uStep")
    const limit = gl.getUniformLocation(this.blur, "uThreshold")
    const passes: [Target, Target, number, number, number][] = [
      [a, b, 1.5 / this.width, 0, threshold],
      [b, a, 0, 1.5 / this.height, 0],
      [a, b, 3 / this.width, 0, 0],
      [b, a, 0, 3 / this.height, 0],
    ]
    for (const [from, to, x, y, t] of passes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer)
      gl.bindTexture(gl.TEXTURE_2D, from.texture)
      gl.uniform2f(step, x, y)
      gl.uniform1f(limit, t)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, fullWidth, fullHeight)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(this.composite)
    gl.bindTexture(gl.TEXTURE_2D, a.texture)
    gl.uniform1i(gl.getUniformLocation(this.composite, "uSource"), 0)
    gl.uniform1f(gl.getUniformLocation(this.composite, "uStrength"), strength)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }
}

export function onContextLoss(canvas: HTMLCanvasElement, lost: () => void, restored: () => void): () => void {
  const lose = (event: Event): void => {
    event.preventDefault()
    lost()
  }
  canvas.addEventListener("webglcontextlost", lose)
  canvas.addEventListener("webglcontextrestored", restored)
  return () => {
    canvas.removeEventListener("webglcontextlost", lose)
    canvas.removeEventListener("webglcontextrestored", restored)
  }
}
