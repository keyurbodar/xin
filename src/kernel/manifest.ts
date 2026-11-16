import { arr, compile, int, obj, opt, str } from "@earendil-works/pi-schema"
import { satisfies } from "../semver.ts"

/** The kernel contract a plugin module is written against. Breaking changes bump it. */
export const PLUGIN_API = 1

/**
 * What a plugin may ask the owner for. A permission guards kernel services: a row whose code reaches one
 * without declaring the permission fails at mount (its `inject`) or at the access (any other service read,
 * see `IngleLoader.refusal`), and `scripts/boundaries.ts` refuses the reads the runtime cannot see. `runtime`
 * guards `host`, the raw Durable Object storage, environment and bindings, so it implies every other
 * permission. `network` guards no service and is shown to the owner but not enforced. Rows run in the Home's
 * own isolate with no sandbox: the checks keep honest code to its declaration, they do not confine hostile code.
 */
export const PERMISSIONS = {
  secrets: { title: "Read your stored credentials", services: ["secrets"] },
  files: { title: "Read and change your files", services: ["files"] },
  storage: { title: "Keep its own tables in your Home", services: ["db"] },
  routes: { title: "Answer HTTP requests to your Home", services: ["http"] },
  models: { title: "Call models, which spends tokens", services: ["models"] },
  conversations: { title: "Read and write your conversations", services: ["harness"] },
  plugins: { title: "Install, enable and configure plugins", services: ["kernel", "packages", "plugins"] },
  network: { title: "Connect to the internet", services: [] },
  runtime: { title: "Full access to your Home: raw storage, keys and the file bucket", services: ["host"] },
  owner: { title: "Act as you: run any op you can, such as starting threads", services: [] },
} as const satisfies Readonly<Record<string, { readonly title: string; readonly services: readonly string[] }>>

export type Permission = keyof typeof PERMISSIONS

/** Whether a declaration grants `permission`: `runtime` reaches the raw Home, so it grants every other one but `owner`. */
export const grants = (permissions: readonly Permission[], permission: Permission): boolean =>
  permissions.includes(permission) || (permission !== "owner" && permissions.includes("runtime"))

/** The one package that may declare `owner`: first-party Automations, which runs ops as the owner by design. */
export const OWNER_PACKAGE = "ingle-plugin-automations"
/** Where that package ships in this repository; a package of the same name anywhere else gets no `owner`. */
export const OWNER_DIR = "plugins/automations"

/** A package that ships in this repository: its name and its directory relative to the repository root. */
export type FirstParty = { readonly pkg: string; readonly dir: string }

export const isPermission = (value: string): value is Permission => Object.hasOwn(PERMISSIONS, value)

/** What a row registers. A name ending in `*` covers every name with that prefix. */
export type Contributes = { readonly tools: readonly string[]; readonly ops: readonly string[] }

/**
 * What a plugin declares about itself in `package.json` under `ingle.plugins.<name>`.
 * Everything is optional. A plugin that leaves out `contributes` is not checked for what it registers.
 */
export type Manifest = {
  readonly api: number
  readonly requires: readonly string[]
  readonly permissions: readonly Permission[]
  readonly contributes?: Contributes
}

export const DEFAULT_MANIFEST: Manifest = {
  api: PLUGIN_API,
  requires: [],
  permissions: [],
}

export type ManifestProblem =
  | { readonly kind: "api"; readonly declared: number; readonly supported: number }
  | { readonly kind: "require"; readonly spec: string; readonly reason: "missing" | "version" }
  | { readonly kind: "permission"; readonly permission: Permission; readonly service: string }

const Name = str({ minLength: 1, maxLength: 128 })

const ManifestSchema = obj({
  api: opt(int({ minimum: 1 })),
  requires: opt(arr(Name)),
  permissions: opt(arr(Name)),
  contributes: opt(obj({ tools: opt(arr(Name)), ops: opt(arr(Name)) })),
})

const manifestCheck = compile(ManifestSchema)

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/
const REQUIRE = /^([a-z][a-z0-9-]*)(?:@(.+))?$/

/** Parse the declaration keys of one plugin entry. Throws with the entry's location on a bad value. */
/** `firstParty` names the package when it ships in this repository; only Automations at its own path may declare `owner`. */
export function readManifest(value: unknown, where: string, firstParty?: FirstParty): Manifest {
  if (!manifestCheck.check(value)) {
    const detail = manifestCheck
      .errors(value)
      .map((error) => `${error.path} ${error.message}`)
      .join("; ")
    throw new Error(`${where}: ${detail}`)
  }
  for (const spec of value.requires ?? []) {
    const match = REQUIRE.exec(spec)
    if (match === null || !PLUGIN_NAME.test(match[1] ?? ""))
      throw new Error(`${where}: requires ${spec} is not plugin@range`)
  }
  const permissions = (value.permissions ?? []).map((permission) => {
    if (!isPermission(permission))
      throw new Error(`${where}: permission ${permission} is not one of ${Object.keys(PERMISSIONS).join(", ")}`)
    if (permission === "owner" && (firstParty?.pkg !== OWNER_PACKAGE || firstParty.dir !== OWNER_DIR))
      throw new Error(`${where}: only first-party ${OWNER_PACKAGE} at ${OWNER_DIR} may declare the owner permission`)
    return permission
  })
  const contributes = value.contributes
  return Object.freeze({
    api: value.api ?? DEFAULT_MANIFEST.api,
    requires: Object.freeze([...(value.requires ?? [])]),
    permissions: Object.freeze([...new Set(permissions)].toSorted()),
    ...(contributes === undefined
      ? {}
      : {
          contributes: Object.freeze({
            tools: Object.freeze([...(contributes.tools ?? [])]),
            ops: Object.freeze([...(contributes.ops ?? [])]),
          }),
        }),
  })
}

/** Whether a declared name list covers `name`, exactly or through a trailing `*`. */
export const covers = (declared: readonly string[], name: string): boolean =>
  declared.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name))

/** The permission a service needs, if it is guarded. */
export function permissionFor(service: string): Permission | undefined {
  for (const [permission, spec] of Object.entries(PERMISSIONS))
    if ((spec.services as readonly string[]).includes(service) && isPermission(permission)) return permission
  return undefined
}

/** The permissions a plugin's `inject` needs, sorted. */
export const permissionsFor = (services: readonly string[]): readonly Permission[] =>
  [...new Set(services.flatMap((service) => permissionFor(service) ?? []))].toSorted()

/** The service names a Cordis plugin's `inject` lists, in array or object form. */
export function injectOf(plugin: unknown): readonly string[] {
  const inject: unknown =
    typeof plugin === "object" || typeof plugin === "function" ? Reflect.get(plugin ?? {}, "inject") : undefined
  if (Array.isArray(inject)) return inject.filter((name): name is string => typeof name === "string")
  if (typeof inject === "object" && inject !== null) return Object.keys(inject)
  return []
}

function parseRequire(spec: string): { readonly name: string; readonly range?: string } | undefined {
  const match = REQUIRE.exec(spec)
  const name = match?.[1]
  if (name === undefined) return undefined
  const range = match?.[2]
  return { name, ...(range === undefined ? {} : { range }) }
}

/**
 * The first reason this build cannot mount the plugin, if any. `versionOf` resolves a plugin name to
 * its build version; `inject` is the services the module asks for.
 */
export function checkManifest(
  manifest: Manifest,
  versionOf: (plugin: string) => string | undefined,
  inject: readonly string[] = [],
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
  for (const service of inject) {
    const permission = permissionFor(service)
    if (permission !== undefined && !manifest.permissions.includes(permission))
      return { kind: "permission", permission, service }
  }
  return undefined
}

export function describeProblem(problem: ManifestProblem): string {
  switch (problem.kind) {
    case "api":
      return `plugin API ${problem.declared} is not supported; this build supports ${problem.supported}`
    case "require":
      return problem.reason === "missing"
        ? `requires plugin ${problem.spec}, which this build does not have`
        : `requires plugin ${problem.spec}, which this build does not satisfy`
    case "permission":
      return `uses the ${problem.service} service without declaring the ${problem.permission} permission`
    default: {
      const _exhaustive: never = problem
      return _exhaustive
    }
  }
}
