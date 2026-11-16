// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import type { Camera } from "../../runtime/scene.ts"
import {
  describeCompileError,
  MAX_BUFFERS,
  shaderProgram,
  validateShader,
  type Blend,
} from "../../runtime/shader-check.ts"
import { VisualError } from "../../runtime/style.ts"
import {
  Bloom,
  compileShader,
  FULLSCREEN_VS,
  frameLoop,
  onContextLoss,
  reducedMotion,
  trackPointer,
  uniforms,
  watchSurface,
} from "./gl.ts"

export interface ShaderOptions {
  height: number
  code: string
  buffers: readonly string[]
  inputs: Readonly<Record<string, number>>
  blend: Blend
  bloom: number
  orbit: boolean
  spin: number
  camera: Camera
  animate: boolean
}

export interface MountedShader {
  update(options: ShaderOptions, theme: Readonly<Record<string, string>>): void
  destroy(): void
}

const BLEND_MODE: Readonly<Record<Blend, number>> = { alpha: 0, light: 1, opaque: 2 }
const RAW = 3

interface Pass {
  program: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation>
}

interface Feedback {
  textures: [WebGLTexture, WebGLTexture]
  framebuffers: [WebGLFramebuffer, WebGLFramebuffer]
  latest: 0 | 1
}

interface Gpu {
  gl: WebGL2RenderingContext
  vao: WebGLVertexArrayObject
  noise: WebGLTexture
  black: WebGLTexture
  float: boolean
  bloom: Bloom
  passes: Pass[]
  image: Pass | undefined
  feedback: Feedback[]
  size: [number, number]
  key: string
}

function noiseTexture(gl: WebGL2RenderingContext): WebGLTexture {
  let seed = 0x9e3779b9
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) & 255
  }
  const data = new Uint8Array(256 * 256 * 4)
  for (let i = 0; i < data.length; i++) data[i] = random()
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  return texture
}

function blackTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  return texture
}

function createGpu(canvas: HTMLCanvasElement): Gpu | undefined {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false })
  if (gl === null) return undefined
  return {
    gl,
    vao: gl.createVertexArray(),
    noise: noiseTexture(gl),
    black: blackTexture(gl),
    float: gl.getExtension("EXT_color_buffer_float") !== null,
    bloom: new Bloom(gl),
    passes: [],
    image: undefined,
    feedback: [],
    size: [0, 0],
    key: "",
  }
}

function compilePasses(gpu: Gpu, options: ShaderOptions, names: readonly string[]): VisualError | undefined {
  const gl = gpu.gl
  for (const pass of gpu.passes) gl.deleteProgram(pass.program)
  gpu.passes = []
  gpu.image = undefined
  if (options.buffers.length > MAX_BUFFERS) return new VisualError(`ui.shader takes at most ${MAX_BUFFERS} buffers`)
  const sources = [...options.buffers, options.code]
  const vertex = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS)
  if (typeof vertex === "string") return new VisualError(`shader: ${vertex}`)
  const passes: Pass[] = []
  for (const [index, code] of sources.entries()) {
    const prefix = index < options.buffers.length ? `in shader buffer ${index + 1}: ` : ""
    const invalid = validateShader(code, names)
    if (invalid !== undefined) return new VisualError(prefix + invalid)
    const { source, offset } = shaderProgram(code, names)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, source)
    if (typeof fragment === "string") return new VisualError(prefix + describeCompileError(fragment, offset))
    const program = gl.createProgram()
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(fragment)
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      const log = gl.getProgramInfoLog(program) ?? "failed to link"
      gl.deleteProgram(program)
      return new VisualError(`${prefix}shader: ${log.trim()}`)
    }
    passes.push({ program, uniforms: uniforms(gl, program) })
  }
  gl.deleteShader(vertex)
  gpu.image = passes.pop()
  gpu.passes = passes
  return undefined
}

function allocateFeedback(gpu: Gpu, width: number, height: number): void {
  const gl = gpu.gl
  for (const feedback of gpu.feedback) {
    for (const texture of feedback.textures) gl.deleteTexture(texture)
    for (const framebuffer of feedback.framebuffers) gl.deleteFramebuffer(framebuffer)
  }
  const texture = (): WebGLTexture => {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    if (gpu.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  const framebuffer = (target: WebGLTexture): WebGLFramebuffer => {
    const f = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, f)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return f
  }
  gpu.feedback = gpu.passes.map(() => {
    const textures: [WebGLTexture, WebGLTexture] = [texture(), texture()]
    return { textures, framebuffers: [framebuffer(textures[0]), framebuffer(textures[1])], latest: 0 }
  })
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gpu.size = [width, height]
}

interface Frame {
  width: number
  height: number
  dpr: number
  time: number
  delta: number
  frame: number
  mouse: [number, number, number, number]
  camera: [number, number, number]
  inputs: readonly [string, number][]
}

function bindPass(gpu: Gpu, pass: Pass, frame: Frame, blend: number, scale: number): void {
  const gl = gpu.gl
  gl.useProgram(pass.program)
  const at = (name: string): WebGLUniformLocation | null => pass.uniforms.get(name) ?? null
  gl.uniform3f(at("iResolution"), frame.width, frame.height, frame.dpr)
  gl.uniform1f(at("iTime"), frame.time)
  gl.uniform1f(at("iTimeDelta"), frame.delta)
  gl.uniform1i(at("iFrame"), frame.frame)
  gl.uniform4fv(at("iMouse"), frame.mouse)
  gl.uniform4f(at("iCamera"), frame.camera[0], frame.camera[1], frame.camera[2], 0)
  gl.uniform2f(at("ingle_scale"), scale, scale)
  gl.uniform1i(at("ingle_blend"), blend)
  for (const [name, value] of frame.inputs) gl.uniform1f(at(name), value)
  const resolution = new Float32Array(12)
  for (let i = 0; i < 4; i++) {
    const feedback = gpu.feedback[i]
    gl.activeTexture(gl.TEXTURE0 + i)
    gl.bindTexture(gl.TEXTURE_2D, feedback === undefined ? gpu.black : feedback.textures[feedback.latest])
    gl.uniform1i(at(`iChannel${i}`), i)
    resolution.set(feedback === undefined ? [0, 0, 0] : [frame.width, frame.height, 1], i * 3)
  }
  gl.uniform3fv(at("iChannelResolution"), resolution)
  gl.activeTexture(gl.TEXTURE4)
  gl.bindTexture(gl.TEXTURE_2D, gpu.noise)
  gl.uniform1i(at("iNoise"), 4)
}

function render(gpu: Gpu, options: ShaderOptions, frame: Frame): void {
  const gl = gpu.gl
  const image = gpu.image
  if (image === undefined) return
  if (gpu.size[0] !== frame.width || gpu.size[1] !== frame.height || gpu.feedback.length !== gpu.passes.length)
    allocateFeedback(gpu, frame.width, frame.height)
  gl.bindVertexArray(gpu.vao)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)
  gpu.passes.forEach((pass, index) => {
    const feedback = gpu.feedback[index]
    if (feedback === undefined) return
    const write = feedback.latest === 0 ? 1 : 0
    gl.bindFramebuffer(gl.FRAMEBUFFER, feedback.framebuffers[write])
    gl.viewport(0, 0, frame.width, frame.height)
    bindPass(gpu, pass, frame, RAW, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    feedback.latest = write
  })
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, frame.width, frame.height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  bindPass(gpu, image, frame, BLEND_MODE[options.blend], 1)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  if (options.bloom > 0) {
    gpu.bloom.begin(frame.width, frame.height)
    gl.disable(gl.DEPTH_TEST)
    gl.bindVertexArray(gpu.vao)
    bindPass(gpu, image, frame, BLEND_MODE[options.blend], frame.width / gpu.bloom.size[0])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gpu.bloom.finish(options.bloom, 0.55, frame.width, frame.height)
  }
  gl.bindVertexArray(null)
}

export function mountShader(
  canvas: HTMLCanvasElement,
  initial: ShaderOptions,
  theme: Readonly<Record<string, string>>,
  onError: (error: Error) => void,
): MountedShader {
  let options = initial
  let gpu = createGpu(canvas)
  let failed = false
  let dirty = true
  let time = 0
  let frames = 0
  let spun = 0
  let turn = { yaw: 0, pitch: 0 }
  let dragging = false
  let mouse: [number, number, number, number] = [0, 0, 0, 0]

  const fail = (error: Error): void => {
    failed = true
    onError(error)
  }
  if (gpu === undefined) fail(new VisualError("this browser cannot run WebGL2, so the shader cannot render"))

  const names = (): string[] => Object.keys(options.inputs).toSorted()
  const spinning = (): boolean => options.spin !== 0 && !reducedMotion()

  const prepare = (target: Gpu): boolean => {
    const key = JSON.stringify([options.code, options.buffers, names()])
    if (key === target.key && target.image !== undefined) return true
    target.key = key
    const error = compilePasses(target, options, names())
    if (error === undefined) return true
    fail(error)
    return false
  }

  const tick = (delta: number): boolean => {
    if (failed || gpu === undefined || !surface.visible) return false
    if (!prepare(gpu)) return false
    const animating = options.animate
    if (animating) time += delta
    if (spinning() && !dragging) spun += options.spin * delta
    if (!animating && !dirty && !spinning()) return false
    dirty = false
    const camera = options.camera
    render(gpu, options, {
      width: surface.width,
      height: surface.height,
      dpr: surface.dpr,
      time,
      delta: animating ? delta : 0,
      frame: frames,
      mouse,
      camera: [camera.yaw + turn.yaw + spun, Math.min(1.5, Math.max(-1.5, camera.pitch + turn.pitch)), camera.zoom],
      inputs: names().map((name): [string, number] => [name, options.inputs[name] ?? 0]),
    })
    frames += 1
    return animating || spinning()
  }

  const loop = frameLoop(tick)
  const surface = watchSurface(canvas, options.height, () => {
    dirty = true
    loop.kick()
  })

  const style = (): void => {
    canvas.style.touchAction = options.orbit ? "pan-y" : ""
    canvas.style.cursor = options.orbit ? (dragging ? "grabbing" : "grab") : ""
  }
  style()

  const device = (x: number, y: number): [number, number] => {
    const dpr = surface.dpr
    return [x * dpr, surface.height - y * dpr]
  }
  const detachPointer = trackPointer(canvas, {
    down(x, y) {
      const [px, py] = device(x, y)
      mouse = [px, py, px, py]
      dragging = options.orbit
      style()
      dirty = true
      loop.kick()
    },
    drag(dx, dy, x, y) {
      const [px, py] = device(x, y)
      mouse = [px, py, mouse[2], mouse[3]]
      if (options.orbit)
        turn = { yaw: turn.yaw - dx * 0.008, pitch: Math.min(1.5, Math.max(-1.5, turn.pitch + dy * 0.008)) }
      dirty = true
      loop.kick()
    },
    up() {
      mouse = [mouse[0], mouse[1], -Math.abs(mouse[2]), -Math.abs(mouse[3])]
      dragging = false
      style()
      dirty = true
      loop.kick()
    },
    hover() {},
    leave() {},
  })

  const detachLoss = onContextLoss(
    canvas,
    () => {
      gpu = undefined
    },
    () => {
      gpu = createGpu(canvas)
      dirty = true
      loop.kick()
    },
  )

  return {
    update(next) {
      if (
        next.camera.yaw !== options.camera.yaw ||
        next.camera.pitch !== options.camera.pitch ||
        next.camera.zoom !== options.camera.zoom
      ) {
        turn = { yaw: 0, pitch: 0 }
        spun = 0
      }
      options = next
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
      gpu?.gl.getExtension("WEBGL_lose_context")?.loseContext()
      gpu = undefined
    },
  }
}
