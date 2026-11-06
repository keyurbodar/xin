import type { Extension } from "@earendil-works/pi-durable"
import type { PluginId } from "../ids.ts"
import type { Op } from "../ops.ts"

export type Permissions = {
  readonly net: readonly string[]
  readonly memory: "none" | "read" | "write"
  readonly files: "none" | "project" | "all"
}

export type Manifest = {
  readonly id: PluginId
  readonly version: string
  readonly requires: readonly string[]
  readonly provides: readonly string[]
  readonly permissions: Permissions
}

export type PluginHost = {
  readonly id: PluginId
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export type PluginParts = { readonly extensions?: readonly Extension[]; readonly ops?: readonly Op[] }

export type Plugin = { readonly manifest: Manifest; setup(host: PluginHost): PluginParts }

export type PluginState =
  | { readonly kind: "active" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "blocked"; readonly missing: readonly string[] }
  | { readonly kind: "disabled" }

export type Reconciled = {
  readonly states: ReadonlyMap<PluginId, PluginState>
  readonly extensions: readonly Extension[]
  readonly ops: ReadonlyMap<string, Op>
}

export function stateError(state: PluginState): string | undefined {
  switch (state.kind) {
    case "failed":
      return state.error
    case "blocked":
      return `missing ${state.missing.join(", ")}`
    case "active":
    case "disabled":
      return undefined
    default: {
      const _exhaustive: never = state
      throw new Error(`unhandled plugin state ${JSON.stringify(_exhaustive)}`)
    }
  }
}

export function definePlugin(manifest: Manifest, setup: (host: PluginHost) => PluginParts): Plugin {
  return { manifest, setup }
}

export function netAllowed(patterns: readonly string[], url: URL): boolean {
  return patterns.some(
    (pattern) =>
      pattern === "*" ||
      pattern === url.hostname ||
      (pattern.startsWith("*.") && url.hostname.endsWith(pattern.slice(1))),
  )
}

export function pluginHost(manifest: Manifest, fetcher: typeof fetch = fetch): PluginHost {
  return {
    id: manifest.id,
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (!netAllowed(manifest.permissions.net, url))
        return Promise.reject(new Error(`plugin ${manifest.id} has no net permission for ${url.hostname}`))
      return fetcher(input, init)
    },
  }
}

export function reconcile(
  plugins: readonly Plugin[],
  enabled: (id: PluginId) => boolean,
  makeHost: (manifest: Manifest) => PluginHost = pluginHost,
): Reconciled {
  const states = new Map<PluginId, PluginState>()
  const extensions: Extension[] = []
  const ops = new Map<string, Op>()
  const provided = new Set<string>()
  let pending = plugins.filter((plugin) => {
    if (enabled(plugin.manifest.id)) return true
    states.set(plugin.manifest.id, { kind: "disabled" })
    return false
  })
  for (let progressed = true; progressed;) {
    progressed = false
    for (const plugin of pending) {
      const { manifest } = plugin
      if (!manifest.requires.every((need) => provided.has(need))) continue
      pending = pending.filter((other) => other !== plugin)
      progressed = true
      try {
        const parts = plugin.setup(makeHost(manifest))
        const clash = (parts.ops ?? []).find((op) => ops.has(op.name))
        if (clash !== undefined) throw new Error(`op ${clash.name} is already provided`)
        extensions.push(...(parts.extensions ?? []))
        for (const op of parts.ops ?? []) ops.set(op.name, op)
        for (const name of [manifest.id, ...manifest.provides]) provided.add(name)
        states.set(manifest.id, { kind: "active" })
      } catch (error) {
        states.set(manifest.id, { kind: "failed", error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  for (const { manifest } of pending)
    states.set(manifest.id, { kind: "blocked", missing: manifest.requires.filter((need) => !provided.has(need)) })
  return { states, extensions, ops }
}
