// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import {
  frameCamera,
  project,
  Scene,
  type Camera,
  type CameraFrame,
  type Paint,
  type SceneColor,
  type V3,
} from "../../runtime/scene.ts"
import { TEXT_METRICS, VisualError } from "../../runtime/style.ts"
import {
  Bloom,
  cssColor,
  frameLoop,
  mustLink,
  onContextLoss,
  reducedMotion,
  trackPointer,
  watchSurface,
  type RGBA,
} from "./gl.ts"

export type Theme = Readonly<Record<string, string>>

export interface SceneOptions {
  height: number
  orbit: boolean
  spin: number
  camera: Camera
  animate: boolean
}

export type DrawScene = (scene: Scene, t: number) => void

export interface MountedScene {
  update(options: SceneOptions, draw: DrawScene, theme: Theme): void
  destroy(): void
}

const PROJECT = `
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec3 uLight;
uniform float uFocal;
uniform float uNear;
uniform float uFar;
uniform float uDpr;
uniform float uRadius;
uniform vec2 uHalf;
vec3 toView(vec3 p) {
  vec3 d = p - uEye;
  return vec3(dot(d, uRight), dot(d, uUp), dot(d, uForward));
}
vec4 toClip(vec3 v) {
  return vec4(v.x * uFocal / uHalf.x, v.y * uFocal / uHalf.y, (v.z * (uFar + uNear) - 2.0 * uFar * uNear) / (uFar - uNear), v.z);
}
`

const MESH_VS = `#version 300 es
precision highp float;
${PROJECT}
in vec3 aPos;
in vec3 aFaceNormal;
in vec3 aNormal;
in vec4 aColor;
in vec4 aMat;
in float aTwoSided;
out vec3 vPos;
out vec3 vFaceNormal;
out vec3 vNormal;
out vec4 vColor;
out vec4 vMat;
out float vTwoSided;
void main() {
  vPos = aPos;
  vFaceNormal = aFaceNormal;
  vNormal = aNormal;
  vColor = aColor;
  vMat = aMat;
  vTwoSided = aTwoSided;
  gl_Position = toClip(toView(aPos));
}`

const MESH_FS = `#version 300 es
precision highp float;
uniform vec3 uEye;
uniform vec3 uLight;
uniform int uGlowPass;
in vec3 vPos;
in vec3 vFaceNormal;
in vec3 vNormal;
in vec4 vColor;
in vec4 vMat;
in float vTwoSided;
out vec4 outColor;
void main() {
  vec3 toEye = uEye - vPos;
  float facing = dot(vFaceNormal, toEye);
  if (vTwoSided < 0.5 && facing < 0.0) discard;
  vec3 n = normalize(vNormal) * (facing < 0.0 ? -1.0 : 1.0);
  vec3 v = normalize(toEye);
  float rough = vMat.x;
  float metal = vMat.y;
  float glow = vMat.z;
  float glass = vMat.w;
  vec3 base = vColor.rgb;
  if (uGlowPass == 1) {
    float g = clamp(glow * 0.6, 0.0, 1.0);
    outColor = vec4(base * g * vColor.a, g * vColor.a);
    return;
  }
  float ndl = dot(n, uLight);
  float key = clamp((ndl + 0.3) / 1.3, 0.0, 1.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 diffuse = base * (0.3 + 0.1 * sky + 0.62 * key) * (1.0 - 0.7 * metal);
  vec3 h = normalize(uLight + v);
  float shininess = mix(180.0, 6.0, rough);
  float spec = pow(max(dot(n, h), 0.0), shininess) * (1.0 - rough) * step(0.0, ndl);
  vec3 highlight = mix(vec3(1.0), base, metal) * spec * mix(0.45, 1.3, metal);
  float fresnel = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 sheen = base * metal * (0.25 + 0.45 * sky) + vec3(fresnel * 0.08 * (1.0 - rough));
  vec3 color = diffuse + highlight + sheen;
  color = mix(color, base * (1.0 + 0.3 * glow), clamp(glow, 0.0, 1.0));
  float alpha = vColor.a * mix(1.0, 0.14 + 0.7 * fresnel, glass);
  color = mix(color, base * 0.6 + vec3(fresnel * 0.4), glass);
  outColor = vec4(color * alpha + highlight * glass, alpha);
}`

const LINE_VS = `#version 300 es
precision highp float;
${PROJECT}
in vec3 aA;
in vec3 aB;
in vec2 aSide;
in vec4 aColor;
in float aWidth;
out vec4 vColor;
out float vOffset;
out float vWidth;
void main() {
  vec3 va = toView(aA);
  vec3 vb = toView(aB);
  vColor = aColor;
  if (va.z < uNear || vb.z < uNear) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  va.z -= uRadius * 1e-3;
  vb.z -= uRadius * 1e-3;
  vec4 ca = toClip(va);
  vec4 cb = toClip(vb);
  vec2 sa = ca.xy / ca.w * uHalf;
  vec2 sb = cb.xy / cb.w * uHalf;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float hw = max(aWidth * uDpr, 1.0) * 0.5;
  float outer = hw + 1.0;
  vec4 c = aSide.x < 0.5 ? ca : cb;
  c.xy += normal * aSide.y * outer / uHalf * c.w;
  gl_Position = c;
  vOffset = aSide.y * outer;
  vWidth = hw;
  vColor.a *= min(aWidth * uDpr, 1.0);
}`

const LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
in float vOffset;
in float vWidth;
out vec4 outColor;
void main() {
  float a = vColor.a * clamp(vWidth + 0.5 - abs(vOffset), 0.0, 1.0);
  outColor = vec4(vColor.rgb * a, a);
}`

const DOT_VS = `#version 300 es
precision highp float;
${PROJECT}
in vec3 aAt;
in vec2 aCorner;
in vec4 aColor;
in float aSize;
in float aGlow;
out vec2 vCorner;
out float vSize;
out vec4 vColor;
out float vGlow;
void main() {
  vec3 v = toView(aAt);
  vColor = aColor;
  vGlow = aGlow;
  if (v.z < uNear) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  v.z -= uRadius * 2e-3;
  vec4 c = toClip(v);
  vSize = aSize * uDpr;
  float outer = aGlow > 0.0 ? vSize : vSize + 1.0;
  vCorner = aCorner * outer;
  c.xy += vCorner / uHalf * c.w;
  gl_Position = c;
}`

const DOT_FS = `#version 300 es
precision highp float;
in vec2 vCorner;
in float vSize;
in vec4 vColor;
in float vGlow;
out vec4 outColor;
void main() {
  float d = length(vCorner);
  if (vGlow > 0.0) {
    float x = d / max(vSize, 1.0);
    float a = vColor.a * min(vGlow, 4.0) * (exp(-x * x * 9.0) * 0.85 + exp(-x * x * 40.0) * 0.6) * step(x, 1.0);
    outColor = vec4(vColor.rgb * a, clamp(a, 0.0, 1.0));
    return;
  }
  float a = vColor.a * clamp(vSize + 0.5 - d, 0.0, 1.0);
  outColor = vec4(vColor.rgb * a, a);
}`

const MESH_STRIDE = 18
const LINE_STRIDE = 13
const DOT_STRIDE = 11

type Attribute = [name: string, size: number]

const MESH_ATTRIBUTES: Attribute[] = [
  ["aPos", 3],
  ["aFaceNormal", 3],
  ["aNormal", 3],
  ["aColor", 4],
  ["aMat", 4],
  ["aTwoSided", 1],
]
const LINE_ATTRIBUTES: Attribute[] = [
  ["aA", 3],
  ["aB", 3],
  ["aSide", 2],
  ["aColor", 4],
  ["aWidth", 1],
]
const DOT_ATTRIBUTES: Attribute[] = [
  ["aAt", 3],
  ["aCorner", 2],
  ["aColor", 4],
  ["aSize", 1],
  ["aGlow", 1],
]

interface Batch {
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  count: number
}

interface Gpu {
  gl: WebGL2RenderingContext
  mesh: WebGLProgram
  line: WebGLProgram
  dot: WebGLProgram
  opaque: Batch
  clear: Batch
  lines: Batch
  dots: Batch
  sprites: Batch
  bloom: Bloom
}

function batch(gl: WebGL2RenderingContext, program: WebGLProgram, attributes: Attribute[]): Batch {
  const vao = gl.createVertexArray()
  const buffer = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  const stride = attributes.reduce((sum, [, size]) => sum + size, 0) * 4
  let offset = 0
  for (const [name, size] of attributes) {
    const location = gl.getAttribLocation(program, name)
    if (location >= 0) {
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset)
    }
    offset += size * 4
  }
  gl.bindVertexArray(null)
  return { vao, buffer, count: 0 }
}

function createGpu(canvas: HTMLCanvasElement): Gpu | undefined {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true })
  if (gl === null) return undefined
  const mesh = mustLink(gl, MESH_VS, MESH_FS)
  const line = mustLink(gl, LINE_VS, LINE_FS)
  const dot = mustLink(gl, DOT_VS, DOT_FS)
  return {
    gl,
    mesh,
    line,
    dot,
    opaque: batch(gl, mesh, MESH_ATTRIBUTES),
    clear: batch(gl, mesh, MESH_ATTRIBUTES),
    lines: batch(gl, line, LINE_ATTRIBUTES),
    dots: batch(gl, dot, DOT_ATTRIBUTES),
    sprites: batch(gl, dot, DOT_ATTRIBUTES),
    bloom: new Bloom(gl),
  }
}

function upload(gl: WebGL2RenderingContext, target: Batch, data: Float32Array, stride: number): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, target.buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
  target.count = data.length / stride
}

class Palette {
  constructor(private readonly theme: Theme) {}

  private paint(paint: Paint): RGBA {
    if (paint.kind === "rgb") return cssColor(paint.hex)
    const css = this.theme[paint.token]
    if (css === undefined) throw new VisualError(`the theme has no colour for '${paint.token}'`)
    return cssColor(css)
  }

  rgba(color: SceneColor): RGBA {
    const [r, g, b, a] = this.paint(color.paint)
    if (color.mix === undefined) return [r, g, b, a * color.alpha]
    const [r2, g2, b2, a2] = this.paint(color.mix.paint)
    const t = color.mix.t
    return [r + (r2 - r) * t, g + (g2 - g) * t, b + (b2 - b) * t, (a + (a2 - a) * t) * color.alpha]
  }

  css(color: SceneColor): string {
    if (color.mix === undefined && color.alpha === 1 && color.paint.kind === "token") {
      const css = this.theme[color.paint.token]
      if (css !== undefined) return css
    }
    const [r, g, b, a] = this.rgba(color)
    return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${a})`
  }
}

interface Geometry {
  scene: Scene
  clear: Float32Array
  clearCentroids: V3[]
}

function build(gpu: Gpu, scene: Scene, palette: Palette): Geometry {
  const opaque: number[] = []
  const clear: number[] = []
  const clearCentroids: V3[] = []
  for (const face of scene.faces) {
    const color = palette.rgba(face.color)
    const m = face.material
    const translucent = color[3] < 0.999 || m.glass > 0
    const out = translucent ? clear : opaque
    const [first] = face.corners
    if (first === undefined) continue
    for (let i = 1; i + 1 < face.corners.length; i++) {
      const corners = [0, i, i + 1]
      for (const k of corners) {
        const p = face.corners[k] ?? first
        const n = face.normals?.[k] ?? face.normal
        out.push(...p, ...face.normal, ...n, ...color, m.roughness, m.metalness, m.glow, m.glass, face.twoSided ? 1 : 0)
      }
      if (translucent) {
        const a = face.corners[i] ?? first
        const b = face.corners[i + 1] ?? first
        clearCentroids.push([(first[0] + a[0] + b[0]) / 3, (first[1] + a[1] + b[1]) / 3, (first[2] + a[2] + b[2]) / 3])
      }
    }
  }
  const lines: number[] = []
  for (const line of scene.lines) {
    const color = palette.rgba(line.color)
    for (const [along, side] of [
      [0, -1],
      [1, -1],
      [1, 1],
      [0, -1],
      [1, 1],
      [0, 1],
    ] as const)
      lines.push(...line.a, ...line.b, along, side, ...color, line.width)
  }
  const quad = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, -1],
    [1, 1],
    [-1, 1],
  ] as const
  const dots: number[] = []
  for (const point of scene.points) {
    const color = palette.rgba(point.color)
    for (const corner of quad) dots.push(...point.at, ...corner, ...color, point.radius, 0)
  }
  const sprites: number[] = []
  for (const sprite of scene.sprites) {
    const color = palette.rgba(sprite.color)
    for (const corner of quad)
      sprites.push(...sprite.at, ...corner, ...color, sprite.size / 2, Math.max(sprite.glow, 1e-3))
  }
  const gl = gpu.gl
  upload(gl, gpu.opaque, new Float32Array(opaque), MESH_STRIDE)
  upload(gl, gpu.lines, new Float32Array(lines), LINE_STRIDE)
  upload(gl, gpu.dots, new Float32Array(dots), DOT_STRIDE)
  upload(gl, gpu.sprites, new Float32Array(sprites), DOT_STRIDE)
  const clearData = new Float32Array(clear)
  upload(gl, gpu.clear, clearData, MESH_STRIDE)
  return { scene, clear: clearData, clearCentroids }
}

function sortClear(gpu: Gpu, geometry: Geometry, frame: CameraFrame): void {
  const triangle = MESH_STRIDE * 3
  if (geometry.clearCentroids.length < 2) return
  const order = geometry.clearCentroids
    .map((c, index) => ({
      index,
      depth:
        (c[0] - frame.eye[0]) * frame.forward[0] +
        (c[1] - frame.eye[1]) * frame.forward[1] +
        (c[2] - frame.eye[2]) * frame.forward[2],
    }))
    .toSorted((a, b) => b.depth - a.depth)
  const sorted = new Float32Array(geometry.clear.length)
  order.forEach(({ index }, slot) =>
    sorted.set(geometry.clear.subarray(index * triangle, (index + 1) * triangle), slot * triangle),
  )
  gpu.gl.bindBuffer(gpu.gl.ARRAY_BUFFER, gpu.clear.buffer)
  gpu.gl.bufferSubData(gpu.gl.ARRAY_BUFFER, 0, sorted)
}

function setFrame(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  frame: CameraFrame,
  width: number,
  height: number,
  dpr: number,
): void {
  gl.useProgram(program)
  const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name)
  gl.uniform3fv(at("uEye"), frame.eye)
  gl.uniform3fv(at("uRight"), frame.right)
  gl.uniform3fv(at("uUp"), frame.up)
  gl.uniform3fv(at("uForward"), frame.forward)
  gl.uniform3fv(at("uLight"), frame.light)
  gl.uniform1f(at("uFocal"), frame.focal)
  gl.uniform1f(at("uNear"), frame.near)
  gl.uniform1f(at("uFar"), frame.far)
  gl.uniform1f(at("uDpr"), dpr)
  gl.uniform1f(at("uRadius"), frame.radius)
  gl.uniform2f(at("uHalf"), width / 2, height / 2)
}

function drawBatch(gl: WebGL2RenderingContext, target: Batch): void {
  if (target.count === 0) return
  gl.bindVertexArray(target.vao)
  gl.drawArrays(gl.TRIANGLES, 0, target.count)
}

function render(gpu: Gpu, geometry: Geometry, frame: CameraFrame, width: number, height: number, dpr: number): void {
  const gl = gpu.gl
  sortClear(gpu, geometry, frame)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, width, height)
  gl.clearColor(0, 0, 0, 0)
  gl.clearDepth(1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.depthMask(true)
  setFrame(gl, gpu.mesh, frame, width, height, dpr)
  gl.uniform1i(gl.getUniformLocation(gpu.mesh, "uGlowPass"), 0)
  drawBatch(gl, gpu.opaque)
  gl.depthMask(false)
  setFrame(gl, gpu.line, frame, width, height, dpr)
  drawBatch(gl, gpu.lines)
  setFrame(gl, gpu.dot, frame, width, height, dpr)
  drawBatch(gl, gpu.dots)
  setFrame(gl, gpu.mesh, frame, width, height, dpr)
  drawBatch(gl, gpu.clear)
  gl.blendFunc(gl.ONE, gl.ONE)
  setFrame(gl, gpu.dot, frame, width, height, dpr)
  drawBatch(gl, gpu.sprites)
  gl.depthMask(true)
  if (!geometry.scene.glows) {
    gl.bindVertexArray(null)
    return
  }
  gpu.bloom.begin(width, height)
  const [w, h] = gpu.bloom.size
  const k = w / width
  const small = { ...frame, focal: frame.focal * k }
  gl.enable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)
  setFrame(gl, gpu.mesh, small, w, h, dpr * k)
  gl.uniform1i(gl.getUniformLocation(gpu.mesh, "uGlowPass"), 1)
  drawBatch(gl, gpu.opaque)
  drawBatch(gl, gpu.clear)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE)
  gl.depthMask(false)
  setFrame(gl, gpu.dot, small, w, h, dpr * k)
  drawBatch(gl, gpu.sprites)
  gl.depthMask(true)
  gl.bindVertexArray(null)
  gpu.bloom.finish(1.1, 0, width, height)
}

const OVERLAY_STYLE = "position:absolute;inset:0;pointer-events:none;overflow:hidden;"
const LABEL_STYLE =
  "position:absolute;left:0;top:0;white-space:nowrap;font-family:var(--font-sans, ui-sans-serif, system-ui, sans-serif);font-variant-numeric:tabular-nums;will-change:transform;"
const HINT_STYLE =
  "position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;padding:4px 8px;border-radius:var(--radius-sm, 6px);background:var(--color-popover);color:var(--color-ink);box-shadow:var(--shadow-popover);font:12px/1.3 var(--font-sans, ui-sans-serif, system-ui, sans-serif);opacity:0;transition:opacity var(--dur-tooltip, 125ms) ease;"

class Overlay {
  readonly root: HTMLDivElement
  private readonly labels: HTMLSpanElement[] = []
  private readonly hint: HTMLDivElement

  constructor(canvas: HTMLCanvasElement) {
    this.root = document.createElement("div")
    this.root.setAttribute("style", OVERLAY_STYLE)
    this.root.setAttribute("aria-hidden", "true")
    this.hint = document.createElement("div")
    this.hint.setAttribute("style", HINT_STYLE)
    this.hint.setAttribute("role", "tooltip")
    this.root.append(this.hint)
    const parent = canvas.parentElement
    if (parent !== null && getComputedStyle(parent).position === "static") parent.style.position = "relative"
    canvas.after(this.root)
  }

  place(geometry: Geometry, frame: CameraFrame, width: number, height: number, dpr: number, palette: Palette): void {
    const labels = geometry.scene.labels
    labels.forEach((label, index) => {
      let span = this.labels[index]
      if (span === undefined) {
        span = document.createElement("span")
        span.setAttribute("style", LABEL_STYLE)
        this.root.insertBefore(span, this.hint)
        this.labels.push(span)
      }
      const [x, y, z] = project(frame, width, height, label.at)
      const [size, lineHeight] = TEXT_METRICS[label.size]
      if (span.textContent !== label.text) span.textContent = label.text
      span.style.fontSize = `${size}px`
      span.style.lineHeight = `${lineHeight}px`
      span.style.color = palette.css(label.color)
      span.style.visibility = z < frame.near ? "hidden" : "visible"
      span.style.transform = `translate3d(${x / dpr}px, ${y / dpr}px, 0) translate(-50%, -50%)`
    })
    for (const span of this.labels.splice(labels.length)) span.remove()
  }

  showHint(text: string | undefined, x: number, y: number, width: number): void {
    if (text === undefined) {
      this.hint.style.opacity = "0"
      return
    }
    if (this.hint.textContent !== text) this.hint.textContent = text
    const half = this.hint.offsetWidth / 2
    const left = Math.min(Math.max(x, half + 4), Math.max(half + 4, width - half - 4))
    this.hint.style.transform = `translate3d(${left}px, ${y}px, 0) translate(-50%, calc(-100% - 10px))`
    this.hint.style.opacity = "1"
  }

  destroy(): void {
    this.root.remove()
  }
}

const sameCamera = (a: Camera, b: Camera): boolean => a.yaw === b.yaw && a.pitch === b.pitch && a.zoom === b.zoom

export function mountScene(
  canvas: HTMLCanvasElement,
  initial: SceneOptions,
  initialDraw: DrawScene,
  initialTheme: Theme,
  onError: (error: Error) => void,
): MountedScene {
  let options = initial
  let draw = initialDraw
  let palette = new Palette(initialTheme)
  let gpu = createGpu(canvas)
  let geometry: Geometry | undefined
  let frame: CameraFrame | undefined
  let dirty = true
  let failed = false
  let clock = 0
  let spun = 0
  let turn = { yaw: 0, pitch: 0 }
  let dragging = false
  let hover: [number, number] | undefined
  const overlay = new Overlay(canvas)

  const fail = (error: unknown): void => {
    failed = true
    onError(error instanceof Error ? error : new VisualError(String(error)))
  }
  if (gpu === undefined) fail(new VisualError("this browser cannot run WebGL2, so the 3D scene cannot render"))

  const spinning = (): boolean => options.spin !== 0 && !reducedMotion()

  const camera = (): Camera => ({
    yaw: options.camera.yaw + turn.yaw + spun,
    pitch: Math.min(1.5, Math.max(-1.5, options.camera.pitch + turn.pitch)),
    zoom: options.camera.zoom,
  })

  const updateHint = (): void => {
    if (hover === undefined || geometry === undefined || frame === undefined || dragging) {
      overlay.showHint(undefined, 0, 0, 0)
      return
    }
    const dpr = surface.dpr
    let best: { text: string; x: number; y: number; distance: number } | undefined
    for (const point of geometry.scene.points) {
      if (point.hint === undefined) continue
      const [px, py, z] = project(frame, surface.width, surface.height, point.at)
      if (z < frame.near) continue
      const x = px / dpr
      const y = py / dpr
      const distance = Math.hypot(x - hover[0], y - hover[1])
      if (distance <= Math.max(point.radius, 4) + 2 && (best === undefined || distance < best.distance))
        best = { text: point.hint, x, y: y - point.radius, distance }
    }
    overlay.showHint(best?.text, best?.x ?? 0, best?.y ?? 0, surface.width / dpr)
  }

  const tick = (delta: number): boolean => {
    if (failed || gpu === undefined || !surface.visible) return false
    if (options.animate) clock += delta
    if (spinning() && !dragging) spun += options.spin * delta
    try {
      if (dirty || options.animate || geometry === undefined) {
        const scene = new Scene(clock)
        draw(scene, clock)
        geometry = build(gpu, scene, palette)
        dirty = false
      }
      const bounds = geometry.scene.bounds()
      if (bounds === undefined) {
        frame = undefined
        gpu.gl.clearColor(0, 0, 0, 0)
        gpu.gl.clear(gpu.gl.COLOR_BUFFER_BIT)
      } else {
        frame = frameCamera(bounds, camera(), surface.width, surface.height)
        render(gpu, geometry, frame, surface.width, surface.height, surface.dpr)
        overlay.place(geometry, frame, surface.width, surface.height, surface.dpr, palette)
      }
      updateHint()
    } catch (error) {
      fail(error)
      return false
    }
    return options.animate || spinning()
  }

  const loop = frameLoop(tick)
  const surface = watchSurface(canvas, options.height, () => loop.kick())

  const style = (): void => {
    canvas.style.touchAction = options.orbit ? "pan-y" : ""
    canvas.style.cursor = options.orbit ? (dragging ? "grabbing" : "grab") : ""
  }
  style()

  const detachPointer = trackPointer(canvas, {
    down() {
      if (!options.orbit) return
      dragging = true
      style()
      updateHint()
    },
    drag(dx, dy) {
      if (!options.orbit) return
      turn = { yaw: turn.yaw - dx * 0.008, pitch: Math.min(1.5, Math.max(-1.5, turn.pitch + dy * 0.008)) }
      loop.kick()
    },
    up(x, y, tap) {
      dragging = false
      style()
      hover = tap ? [x, y] : hover
      updateHint()
      loop.kick()
    },
    hover(x, y) {
      hover = [x, y]
      updateHint()
    },
    leave() {
      hover = undefined
      updateHint()
    },
  })

  const detachLoss = onContextLoss(
    canvas,
    () => {
      gpu = undefined
      geometry = undefined
    },
    () => {
      gpu = createGpu(canvas)
      dirty = true
      loop.kick()
    },
  )

  return {
    update(next, nextDraw, theme) {
      if (!sameCamera(next.camera, options.camera)) {
        turn = { yaw: 0, pitch: 0 }
        spun = 0
      }
      options = next
      draw = nextDraw
      palette = new Palette(theme)
      surface.setHeight(next.height)
      failed = gpu === undefined
      dirty = true
      style()
      loop.kick()
    },
    destroy() {
      loop.destroy()
      surface.destroy()
      detachPointer()
      detachLoss()
      overlay.destroy()
      gpu?.gl.getExtension("WEBGL_lose_context")?.loseContext()
      gpu = undefined
    },
  }
}
