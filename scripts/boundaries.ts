import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { KERNEL_OWNER, tableOwner } from "../src/kernel/dbtables.ts"

const ROOT = join(import.meta.dirname, "..")
const PLUGINS = join(ROOT, "plugins")
const SPECIFIER = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"'?]+)/g
const SQL_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/g
const SQL_KEYWORDS: ReadonlySet<string> = new Set(["set", "select", "where", "values", "on", "if", "not"])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path)
    return path.endsWith(".ts") ? [path] : []
  })
}

const pluginOf = (path: string): string | undefined => {
  const inside = relative(PLUGINS, path)
  return inside.startsWith("..") ? undefined : inside.split(sep)[0]
}

const owner = (path: string): string => pluginOf(path) ?? "test"

const CONTEXT_BLOCK = /interface Context \{([^}]*)\}/g
const CONTEXT_MEMBER = /^\s*([a-z][A-Za-z0-9]*)\??\s*:/gm
const SERVICE_READ = /\bctx\.([a-z][A-Za-z0-9]*)\b/g
const INJECT = /\binject\s*[:=]\s*\[([^\]]*)\]/g

const services: ReadonlySet<string> = new Set(
  files(join(ROOT, "src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(CONTEXT_BLOCK)].flatMap((block) =>
      [...(block[1] ?? "").matchAll(CONTEXT_MEMBER)].flatMap((member) => (member[1] === undefined ? [] : [member[1]])),
    ),
  ),
)

const injected = (text: string): ReadonlySet<string> | undefined => {
  const lists = [...text.matchAll(INJECT)].map((match) => match[1] ?? "")
  return lists.length === 0
    ? undefined
    : new Set(lists.flatMap((list) => [...list.matchAll(/["']([^"']+)["']/g)].map((item) => item[1] ?? "")))
}

const violations: string[] = []
const checkInject = (file: string, requireDeclaration: boolean, text: string): void => {
  if (file.endsWith(".test.ts")) return
  const inject = injected(text)
  if (inject === undefined && !requireDeclaration) return
  for (const read of new Set([...text.matchAll(SERVICE_READ)].map((match) => match[1] ?? ""))) {
    if (!services.has(read)) continue
    if (inject === undefined)
      violations.push(
        `${relative(ROOT, file)} reads ctx.${read}: only a row module (one that declares inject) reads services; pass a port`,
      )
    else if (!inject.has(read))
      violations.push(`${relative(ROOT, file)} reads ctx.${read} without listing "${read}" in inject`)
  }
}
for (const file of [...files(PLUGINS), ...files(join(ROOT, "test", "plugins"))]) {
  const from = owner(file)
  const text = readFileSync(file, "utf8")
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1]
    if (specifier === undefined) continue
    const target = pluginOf(resolve(dirname(file), specifier))
    if (target !== undefined && target !== from)
      violations.push(
        `${relative(ROOT, file)} imports ${specifier}: reach plugin ${target} through inject and src/contracts`,
      )
  }
  checkInject(file, true, text)
  const plugin = pluginOf(file)
  if (plugin === undefined || file.endsWith(".test.ts")) continue
  for (const match of text.matchAll(SQL_TABLE)) {
    const table = match[1]
    if (table === undefined || SQL_KEYWORDS.has(table.toLowerCase())) continue
    const tableOwnerPlugin = tableOwner(table)
    if (tableOwnerPlugin === undefined || tableOwnerPlugin === KERNEL_OWNER || tableOwnerPlugin === plugin) continue
    violations.push(`${relative(ROOT, file)} uses table ${table}, which belongs to plugin ${tableOwnerPlugin}`)
  }
}
for (const file of files(join(ROOT, "src"))) checkInject(file, false, readFileSync(file, "utf8"))

if (violations.length > 0) {
  for (const line of violations) console.error(line)
  process.exit(1)
}
