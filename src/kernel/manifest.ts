import { arr, compile, int, obj, opt, str } from "@earendil-works/pi-schema"
import { satisfies } from "../semver.ts"

/** The kernel contract a plugin module is written against. Breaking changes bump it. */
export const PLUGIN_API = 1

/**
 * What a plugin declares about itself in `package.json` under `xin.plugins.<name>`.
 * Everything is optional: a plugin that declares nothing runs.
 */
export type Manifest = {
  readonly api: number
  readonly requires: readonly string[]
}

export const DEFAULT_MANIFEST: Manifest = {
  api: PLUGIN_API,
  requires: [],
}

export type ManifestProblem =
  | { readonly kind: "api"; readonly declared: number; readonly supported: number }
  | { readonly kind: "require"; readonly spec: string; readonly reason: "missing" | "version" }

const ManifestSchema = obj({
  api: opt(int({ minimum: 1 })),
  requires: opt(arr(str({ minLength: 1, maxLength: 128 }))),
})

const manifestCheck = compile(ManifestSchema)

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/
const REQUIRE = /^([a-z][a-z0-9-]*)(?:@(.+))?$/

/** Parse the declaration keys of one plugin entry. Throws with the entry's location on a bad value. */
export function readManifest(value: unknown, where: string): Manifest {
  if (!manifestCheck.check(value)) {
    const detail = manifestCheck
      .errors(value)
      .map((error) => `${error.path} ${error.message}`)
      .join("; ")
    throw new Error(`${where}: ${detail}`)
  }
  for (const spec of value.requires ?? []) {
    const match = REQUIRE.exec(spec)
    if (match === null || !PLUGIN_NAME.test(match[1] ?? "")) throw new Error(`${where}: requires ${spec} is not plugin@range`)
  }
  return {
    api: value.api ?? DEFAULT_MANIFEST.api,
    requires: [...(value.requires ?? [])],
  }
}

export function parseRequire(spec: string): { readonly name: string; readonly range?: string } | undefined {
  const match = REQUIRE.exec(spec)
  const name = match?.[1]
  if (name === undefined) return undefined
  const range = match?.[2]
  return { name, ...(range === undefined ? {} : { range }) }
}

/** The first reason this build cannot mount the plugin, if any. `versionOf` resolves a plugin name to its build version. */
export function checkManifest(
  manifest: Manifest,
  versionOf: (plugin: string) => string | undefined,
): ManifestProblem | undefined {
  if (manifest.api !== PLUGIN_API) return { kind: "api", declared: manifest.api, supported: PLUGIN_API }
  for (const spec of manifest.requires) {
    const required = parseRequire(spec)
    if (required === undefined) return { kind: "require", spec, reason: "missing" }
    const version = versionOf(required.name)
    if (version === undefined) return { kind: "require", spec, reason: "missing" }
    if (required.range !== undefined && !satisfies(version, required.range))
      return { kind: "require", spec, reason: "version" }
  }
  return undefined
}

export function describeProblem(problem: ManifestProblem): string {
  if (problem.kind === "api")
    return `plugin API ${problem.declared} is not supported; this build supports ${problem.supported}`
  return problem.reason === "missing"
    ? `requires plugin ${problem.spec}, which this build does not have`
    : `requires plugin ${problem.spec}, which this build does not satisfy`
}
