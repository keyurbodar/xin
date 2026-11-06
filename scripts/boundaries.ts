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

const violations: string[] = []
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

if (violations.length > 0) {
  for (const line of violations) console.error(line)
  process.exit(1)
}
