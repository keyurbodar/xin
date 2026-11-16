// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { Meter, PER_CHECK } from "./limits.ts"
import { Scene, SCENE_METHODS } from "./scene.ts"
import { validateShader } from "./shader-check.ts"
import { type HandlerArg, type SceneTarget, Visual } from "./lua.ts"
import type { HandlerId, Node } from "./node.ts"
import { VisualError } from "./style.ts"

export type Report = { readonly nodes: number; readonly interactions: number; readonly logs: readonly string[] }

type Interaction = { readonly describe: string; readonly path: readonly number[]; readonly arg: HandlerArg }

const MAX_INTERACTIONS = 24

export function children(node: Node): readonly Node[] {
  switch (node.kind) {
    case "stack":
    case "grid":
      return node.children
    case "table":
      return node.rows.flat()
    default:
      return []
  }
}

export function sceneTarget(scene: Scene): SceneTarget {
  const target: Record<string, SceneTarget[string]> = {}
  for (const method of SCENE_METHODS) target[method] = (...args) => scene.call(method, args)
  return target
}

const where = (prefix: string, error: unknown): VisualError =>
  new VisualError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)

function exercise(visual: Visual, node: Node, count: { nodes: number }): void {
  count.nodes += 1
  if (node.kind === "canvas") {
    for (const time of node.animate ? [0, 1.5] : [0]) {
      try {
        visual.drawCanvas(node.draw, 640, node.height, time, { x: 320, y: node.height / 2, down: false })
      } catch (error) {
        throw where("in a canvas draw", error)
      }
    }
  } else if (node.kind === "scene") {
    const scene = new Scene(0)
    try {
      visual.drawScene(node.draw, 0, sceneTarget(scene))
    } catch (error) {
      throw where("in a scene draw", error)
    }
    if (scene.isEmpty())
      throw new VisualError(
        "a scene draw added no geometry (use s:box, s:sphere, s:surface, s:mesh, s:line, s:point, s:sprite)",
      )
  } else if (node.kind === "shader") {
    const names = node.inputs.map(([name]) => name)
    node.buffers.forEach((buffer, index) => {
      const error = validateShader(buffer, names)
      if (error !== undefined) throw new VisualError(`in shader buffer ${index + 1}: ${error}`)
    })
    const error = validateShader(node.code, names)
    if (error !== undefined) throw new VisualError(error)
  }
  for (const child of children(node)) exercise(visual, child, count)
}

function interactions(root: Node): Interaction[] {
  const out: Interaction[] = []
  const walk = (node: Node, path: number[]): void => {
    switch (node.kind) {
      case "tabs":
        for (const option of node.options.filter((candidate) => candidate !== node.value))
          out.push({ describe: `selecting tab '${option}'`, path: [...path], arg: { kind: "text", value: option } })
        out.push({
          describe: `selecting tab '${node.value}'`,
          path: [...path],
          arg: { kind: "text", value: node.value },
        })
        break
      case "toggle":
        out.push({ describe: `switching '${node.label}'`, path: [...path], arg: { kind: "bool", value: !node.value } })
        break
      case "slider": {
        const name = node.label ?? "a slider"
        out.push({
          describe: `moving ${name} to its maximum`,
          path: [...path],
          arg: { kind: "number", value: node.max },
        })
        out.push({
          describe: `moving ${name} to its minimum`,
          path: [...path],
          arg: { kind: "number", value: node.min },
        })
        break
      }
      case "button":
        out.push({ describe: `pressing '${node.label}'`, path: [...path], arg: { kind: "none" } })
        break
      case "stack":
        if (node.onClick !== undefined) out.push({ describe: "clicking a row", path: [...path], arg: { kind: "none" } })
        break
      default:
        break
    }
    children(node).forEach((child, index) => walk(child, [...path, index]))
  }
  walk(root, [])
  return out
}

function handlerAt(root: Node, path: readonly number[]): HandlerId | undefined {
  let node: Node | undefined = root
  for (const index of path) node = node === undefined ? undefined : children(node)[index]
  if (node === undefined) return undefined
  switch (node.kind) {
    case "tabs":
    case "toggle":
    case "slider":
      return node.onChange
    case "button":
      return node.onClick
    case "stack":
      return node.onClick
    default:
      return undefined
  }
}

/** Run a script the way the reader's browser will: setup, the first render, every draw, then each control once with a render after it. */
export function check(source: string, seed: number): Report {
  const visual = Visual.load(source, seed, new Meter(PER_CHECK, "lifetime"))
  const tree = visual.render()
  const count = { nodes: 0 }
  exercise(visual, tree, count)
  let done = 0
  for (const interaction of interactions(tree).slice(0, MAX_INTERACTIONS)) {
    const id = handlerAt(visual.render(), interaction.path)
    if (id === undefined) continue
    try {
      visual.call(id, interaction.arg)
      exercise(visual, visual.render(), { nodes: 0 })
    } catch (error) {
      throw where(`after ${interaction.describe}`, error)
    }
    done += 1
  }
  return { nodes: count.nodes, interactions: done, logs: [...visual.logs] }
}
