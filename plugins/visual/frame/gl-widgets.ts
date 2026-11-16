// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { sceneTarget } from "../runtime/check.ts"
import type { Node } from "../runtime/node.ts"
import { mountScene, type SceneOptions } from "./gl/scene-render.ts"
import { mountShader, type ShaderOptions } from "./gl/shader-render.ts"
import type { Widget, WidgetHost } from "./widget.ts"

type SceneNode = Extract<Node, { kind: "scene" }>
type ShaderNode = Extract<Node, { kind: "shader" }>

function surface(className: string): { element: HTMLDivElement; canvas: HTMLCanvasElement } {
  const element = document.createElement("div")
  element.className = className
  const canvas = document.createElement("canvas")
  element.append(canvas)
  return { element, canvas }
}

const sceneOptions = (node: SceneNode): SceneOptions => ({
  height: node.height,
  orbit: node.orbit,
  spin: node.spin,
  camera: node.camera,
  animate: node.animate,
})

export function sceneWidget(initial: SceneNode, host: WidgetHost): Widget<SceneNode> {
  let node = initial
  const { element, canvas } = surface("v-scene")
  const draw = (): Parameters<typeof mountScene>[2] => (scene, time) =>
    host.visual.drawScene(node.draw, time, sceneTarget(scene))
  const mounted = mountScene(canvas, sceneOptions(node), draw(), host.theme().colors, host.fail)
  return {
    element,
    update(next) {
      node = next
      mounted.update(sceneOptions(node), draw(), host.theme().colors)
    },
    repaint: () => mounted.update(sceneOptions(node), draw(), host.theme().colors),
    destroy: () => mounted.destroy(),
  }
}

const shaderOptions = (node: ShaderNode): ShaderOptions => ({
  height: node.height,
  code: node.code,
  buffers: node.buffers,
  inputs: Object.fromEntries(node.inputs),
  blend: node.blend,
  bloom: node.bloom,
  orbit: node.orbit,
  spin: node.spin,
  camera: node.camera,
  animate: node.animate,
})

export function shaderWidget(initial: ShaderNode, host: WidgetHost): Widget<ShaderNode> {
  let node = initial
  const { element, canvas } = surface("v-shader")
  const mounted = mountShader(canvas, shaderOptions(node), host.theme().colors, host.fail)
  return {
    element,
    update(next) {
      node = next
      mounted.update(shaderOptions(node), host.theme().colors)
    },
    repaint: () => mounted.update(shaderOptions(node), host.theme().colors),
    destroy: () => mounted.destroy(),
  }
}
