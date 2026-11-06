import type { JsonValue } from "@earendil-works/chord"
import type { Extension, JsonObject } from "@earendil-works/pi-durable"
import type { Schema } from "@earendil-works/pi-schema"
import type { PluginId } from "../ids.ts"
import type { Op, Outcome } from "../ops.ts"

export type Permissions = {
  readonly net: readonly string[]
  readonly memory: "none" | "read" | "write"
  readonly files: "none" | "project" | "all"
}

export type SecretSpec = { readonly key: string; readonly label: string }

export type Manifest = {
  readonly id: PluginId
  readonly version: string
  readonly requires: readonly string[]
  readonly provides: readonly string[]
  readonly permissions: Permissions
  readonly secrets?: readonly SecretSpec[]
  readonly config?: Schema<unknown>
}

export type PluginOps = { run(key: string, name: string, args?: JsonValue): Promise<Outcome> }

export type PluginHost<C = JsonObject> = {
  readonly id: PluginId
  readonly config: Readonly<C>
  readonly ops: PluginOps
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  secret(key: string): string
}

export type PluginParts = { readonly extensions?: readonly Extension[]; readonly ops?: readonly Op[] }

export type Plugin = {
  readonly manifest: Manifest
  setup(host: PluginHost): PluginParts
}

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

export function definePlugin<C extends JsonObject = JsonObject>(
  manifest: Omit<Manifest, "config"> & { readonly config?: Schema<C> },
  setup: (host: PluginHost<C>) => PluginParts,
): Plugin {
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

export type HostExtras<C extends JsonObject = JsonObject> = {
  readonly config: Readonly<C>
  readonly secrets?: ReadonlyMap<string, string>
  readonly run: PluginOps["run"]
}

const MAX_REDIRECTS = 5

const isRedirect = (response: Response): boolean => response.status >= 300 && response.status < 400

function nextHop(url: URL, input: string | URL | Request): string | URL | Request {
  return input instanceof Request ? new Request(url, input) : url
}

export function pluginHost<C extends JsonObject = JsonObject>(
  manifest: Manifest,
  fetcher: typeof fetch | undefined,
  extras: HostExtras<C>,
): PluginHost<C> {
  const send = fetcher ?? fetch
  return {
    id: manifest.id,
    config: extras.config,
    ops: { run: (key, name, args) => extras.run(key, name, args) },
    fetch: async (input, init) => {
      let url = new URL(input instanceof Request ? input.url : input)
      let target: string | URL | Request = input
      for (let hop = 0; ; hop += 1) {
        if (!netAllowed(manifest.permissions.net, url))
          throw new Error(`plugin ${manifest.id} has no net permission for ${url.hostname}`)
        const response = await send(target, { ...init, redirect: "manual" })
        const location = isRedirect(response) ? response.headers.get("location") : null
        if (location === null) return response
        if (hop >= MAX_REDIRECTS)
          throw new Error(`plugin ${manifest.id} exceeded ${MAX_REDIRECTS} redirects at ${url.hostname}`)
        url = new URL(location, url)
        target = nextHop(url, input)
      }
    },
    secret: (key) => {
      const value = extras.secrets?.get(key)
      if (value === undefined) throw new Error(`plugin ${manifest.id} has no secret ${key}`)
      return value
    },
  }
}

export function reconcile(
  plugins: readonly Plugin[],
  enabled: (id: PluginId) => boolean,
  makeHost: (manifest: Manifest) => PluginHost,
  reserved: ReadonlySet<string> = new Set(),
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
        const clash = (parts.ops ?? []).find((op) => ops.has(op.name) || reserved.has(op.name))
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
