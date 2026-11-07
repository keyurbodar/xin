import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { CORE_BUNDLES, CORE_CATALOG } from "../src/catalog.ts"

const ROOT = join(import.meta.dirname, "..")
const GENERATED = join(ROOT, "src/catalog.gen.ts")
const PROFILE = join(ROOT, "xin.profile.json")
const NAME = /^[a-z][a-z0-9-]*$/

type Declared = {
  readonly module: string
  readonly title: string
  readonly description: string
  readonly multiple?: boolean
}
type RowSpec = { readonly id: string; readonly name: string; readonly config?: unknown; readonly disabled?: boolean }
type Found = {
  readonly pkg: string
  readonly version: string
  readonly dir: string
  readonly local: boolean
  readonly specifier: (module: string) => string
  readonly plugins: Readonly<Record<string, Declared>>
  readonly bundle: readonly RowSpec[]
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

function parse(path: string, specifier: (module: string) => string, local: boolean): Found | undefined {
  const manifest = readJson(path)
  const xin = field(manifest, "xin")
  if (xin === undefined) return undefined
  const pkg = String(field(manifest, "name"))
  const declared = field(xin, "plugins")
  if (typeof declared !== "object" || declared === null) throw new Error(`${pkg}: xin.plugins must be an object`)
  const plugins: Record<string, Declared> = {}
  for (const [name, entry] of Object.entries(declared)) {
    if (!NAME.test(name)) throw new Error(`${pkg}: plugin name ${name} must be kebab-case`)
    const module = field(entry, "module")
    if (typeof module !== "string") throw new Error(`${pkg}: xin.plugins.${name}.module must be a path`)
    plugins[name] = {
      module,
      title: String(field(entry, "title") ?? name),
      description: String(field(entry, "description") ?? field(manifest, "description") ?? ""),
      ...(field(entry, "multiple") === true ? { multiple: true } : {}),
    }
  }
  const rows = field(xin, "bundle")
  const bundle: RowSpec[] = Array.isArray(rows)
    ? rows.map((row) => {
        const id = field(row, "id")
        const plugin = field(row, "plugin")
        if (typeof id !== "string" || typeof plugin !== "string" || plugins[plugin] === undefined)
          throw new Error(`${pkg}: every bundle row needs an id and a plugin this package declares`)
        const config = field(row, "config")
        const disabled = field(row, "disabled")
        return {
          id,
          name: `cordis:${plugin}`,
          ...(config === undefined ? {} : { config }),
          ...(disabled === true ? { disabled: true } : {}),
        }
      })
    : Object.keys(plugins).map((name) => ({ id: name, name: `cordis:${name}` }))
  return {
    pkg,
    version: String(field(manifest, "version") ?? "0.0.0"),
    dir: dirname(path),
    local,
    specifier,
    plugins,
    bundle,
  }
}

function discover(): Found[] {
  const found: Found[] = []
  const local = join(ROOT, "plugins")
  if (existsSync(local)) {
    for (const name of readdirSync(local).toSorted()) {
      const manifest = join(local, name, "package.json")
      if (!existsSync(manifest)) continue
      const parsed = parse(manifest, (module) => `../plugins/${name}/${module.replace(/^\.\//, "")}`, true)
      if (parsed !== undefined) found.push(parsed)
    }
  }
  const deps = field(readJson(join(ROOT, "package.json")), "dependencies")
  for (const pkg of Object.keys(typeof deps === "object" && deps !== null ? deps : {}).toSorted()) {
    const manifest = join(ROOT, "node_modules", pkg, "package.json")
    if (!existsSync(manifest)) continue
    const parsed = parse(manifest, (module) => `${pkg}/${module.replace(/^\.\//, "")}`, false)
    if (parsed !== undefined) found.push(parsed)
  }
  const seen = new Map<string, string>()
  for (const entry of found)
    for (const name of Object.keys(entry.plugins)) {
      const other = seen.get(name)
      if (other !== undefined) throw new Error(`plugin ${name} is declared by both ${other} and ${entry.pkg}`)
      seen.set(name, entry.pkg)
    }
  return found
}

function assertCoreFree(found: readonly Found[]): void {
  const plugins = new Set(Object.keys(CORE_CATALOG))
  const bundles = new Set(Object.keys(CORE_BUNDLES))
  const rows = new Set(Object.values(CORE_BUNDLES).flatMap((bundle) => bundle.map((row) => row.id)))
  for (const entry of found) {
    for (const name of Object.keys(entry.plugins))
      if (plugins.has(name))
        throw new Error(`${entry.pkg}: plugin "${name}" is a core catalog entry and cannot be overridden`)
    if (bundles.has(entry.pkg))
      throw new Error(`${entry.pkg}: bundle "${entry.pkg}" is a core bundle and cannot be overridden`)
    for (const row of entry.bundle)
      if (rows.has(row.id)) throw new Error(`${entry.pkg}: bundle row "${row.id}" is already used by a core bundle`)
  }
}

function render(found: readonly Found[]): string {
  const imports: string[] = []
  const catalog: string[] = []
  const bundles: string[] = []
  let index = 0
  for (const entry of found) {
    for (const [name, declared] of Object.entries(entry.plugins)) {
      const alias = `p${index++}`
      imports.push(`import * as ${alias} from ${JSON.stringify(entry.specifier(declared.module))}`)
      catalog.push(
        `  ${JSON.stringify(name)}: { plugin: ${alias}, title: ${JSON.stringify(declared.title)}, description: ${JSON.stringify(declared.description)},${declared.multiple === true ? " multiple: true," : ""}${entry.local ? " local: true," : ""} source: ${JSON.stringify(`${entry.pkg}@${entry.version}`)} },`,
      )
    }
    bundles.push(`  ${JSON.stringify(entry.pkg)}: ${JSON.stringify(entry.bundle)},`)
  }
  return [
    ...imports,
    'import type { Row } from "./kernel/layers.ts"',
    'import type { Catalog } from "./kernel/loader.ts"',
    "",
    `export const CATALOG: Catalog = {${catalog.length === 0 ? "" : `\n${catalog.join("\n")}\n`}}`,
    "",
    `export const BUNDLES: Readonly<Record<string, readonly Row[]>> = {${bundles.length === 0 ? "" : `\n${bundles.join("\n")}\n`}}`,
    "",
  ].join("\n")
}

type Profile = { bundles: string[]; patch: unknown[] }

const readProfile = (): Profile => {
  const value = readJson(PROFILE)
  const bundles = field(value, "bundles")
  const patch = field(value, "patch")
  return {
    bundles: Array.isArray(bundles) ? bundles.map(String) : ["xin-base"],
    patch: Array.isArray(patch) ? patch : [],
  }
}

const writeProfile = (profile: Profile) => writeFileSync(PROFILE, `${JSON.stringify(profile, null, 2)}\n`)

function generate(): Found[] {
  const found = discover()
  assertCoreFree(found)
  writeFileSync(GENERATED, render(found))
  if (Bun.spawnSync(["bun", "x", "oxfmt", GENERATED], { cwd: ROOT }).exitCode !== 0)
    throw new Error(`oxfmt failed on ${relative(ROOT, GENERATED)}`)
  console.warn(`wrote ${relative(ROOT, GENERATED)}: ${found.length} package(s)`)
  return found
}

function setBundle(pkg: string, enabled: boolean): void {
  const profile = readProfile()
  const others = profile.bundles.filter((name) => name !== pkg)
  writeProfile({ ...profile, bundles: enabled ? [...others, pkg] : others })
  console.warn(`${enabled ? "enabled" : "disabled"} bundle ${pkg} in xin.profile.json`)
}

async function bun(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "inherit", stderr: "inherit" })
  if ((await child.exited) !== 0) throw new Error(`bun ${args.join(" ")} failed`)
}

type SyncPlan = { readonly add: readonly string[]; readonly remove: readonly string[] }

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined

function syncPlan(value: unknown): SyncPlan {
  const packages = field(value, "packages") ?? value
  const add = stringList(field(packages, "add") ?? [])
  const remove = stringList(field(packages, "remove") ?? [])
  if (add === undefined || remove === undefined)
    throw new Error("plugin sync needs { add: string[], remove: string[] }")
  return { add, remove }
}

async function sync(plan: SyncPlan, dry: boolean): Promise<void> {
  const add = [...new Set(plan.add)]
  const remove = [...new Set(plan.remove)]
  if (add.length === 0 && remove.length === 0) return void console.warn("plugin sync: nothing to do")
  if (dry) {
    for (const pkg of remove) console.warn(`would remove ${pkg}`)
    for (const spec of add) console.warn(`would add ${spec}`)
    return
  }
  for (const pkg of remove) await bun(["remove", pkg])
  const before = new Set(discover().map((entry) => entry.pkg))
  for (const spec of add) await bun(["add", spec])
  for (const pkg of remove) setBundle(pkg, false)
  for (const entry of discover()) if (!before.has(entry.pkg)) setBundle(entry.pkg, true)
  generate()
}

const usage = `usage: bun scripts/xin.ts plugin <command>
  list                       packages with a xin field, their plugins and whether their bundle is enabled
  generate                   rewrite src/catalog.gen.ts from plugins/* and installed dependencies
  add <spec> [--enable]      bun add <spec>, regenerate, and with --enable append its bundle to the profile
  remove <package>           drop its bundle from the profile, bun remove it, regenerate
  enable <package>           append a discovered package's bundle to the profile
  disable <package>          drop a package's bundle from the profile
  sync <file|-> [--dry-run]  apply the pending { add, remove } list from the plugin manager
Code changes reach a running Home only through a rebuild and deploy; activation and config are live ops.`

async function main(argv: readonly string[]): Promise<void> {
  const [group, command, target, ...flags] = argv
  if (group !== "plugin" || command === undefined) return void console.warn(usage)
  switch (command) {
    case "list": {
      const enabled = new Set(readProfile().bundles)
      for (const entry of discover())
        console.warn(
          `${entry.pkg}@${entry.version} ${enabled.has(entry.pkg) ? "enabled" : "disabled"}: ${Object.keys(entry.plugins).join(", ")} (${relative(ROOT, entry.dir)})`,
        )
      return
    }
    case "generate":
      return void generate()
    case "add": {
      if (target === undefined) throw new Error("add needs a spec")
      const before = new Set(discover().map((entry) => entry.pkg))
      await bun(["add", target])
      const added = generate().filter((entry) => !before.has(entry.pkg))
      if (added.length === 0) console.warn(`${target} declares no xin plugins; it is installed but adds nothing`)
      if (flags.includes("--enable")) for (const entry of added) setBundle(entry.pkg, true)
      return
    }
    case "remove": {
      if (target === undefined) throw new Error("remove needs a package name")
      await bun(["remove", target])
      setBundle(target, false)
      return void generate()
    }
    case "enable":
    case "disable": {
      if (target === undefined) throw new Error(`${command} needs a package name`)
      if (!discover().some((entry) => entry.pkg === target)) throw new Error(`no discovered package ${target}`)
      return setBundle(target, command === "enable")
    }
    case "sync": {
      if (target === undefined) throw new Error("sync needs a file or -")
      const text = target === "-" ? await Bun.stdin.text() : readFileSync(target, "utf8")
      return sync(syncPlan(JSON.parse(text)), flags.includes("--dry-run"))
    }
    default:
      console.warn(usage)
  }
}

await main(process.argv.slice(2))
