import { permissionFor } from "../src/kernel/manifest.ts"

const INJECT = /\binject\s*[:=]\s*\[([^\]]*)\]/g
const NESTED_INJECT = /\.inject\(\s*\[([^\]]*)\]/g
const GET = /\bctx\.get\b(\s*\(\s*([^)]*)\))?/g
const ESCAPE = /\bctx\s*\.\s*(root|reflect|fiber|registry|loader)\b/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!["'][^"'`$]*["']\s*\))/
const WORKERS_IMPORT = /["'`]cloudflare:workers["'`]/

/**
 * What a plugin's source reaches without its permissions covering it: the reads the runtime guards cannot see, such as
 * Cordis internals that lead to another fiber's context, an import whose name is computed, or `cloudflare:workers`.
 */
export function reachViolations(where: string, text: string, permitted: ReadonlySet<string>): string[] {
  const violations: string[] = []
  const need = (service: string, how: string): void => {
    const permission = permissionFor(service)
    if (permission !== undefined && !permitted.has(permission))
      violations.push(`${where} ${how} ${service} without the ${permission} permission in its package.json`)
  }
  for (const match of [...text.matchAll(INJECT), ...text.matchAll(NESTED_INJECT)])
    for (const item of (match[1] ?? "").matchAll(/["']([^"']+)["']/g)) need(item[1] ?? "", "injects")
  for (const match of text.matchAll(GET)) {
    if (match[1] === undefined) {
      violations.push(`${where} takes ctx.get as a value; call it with the service's name`)
      continue
    }
    const literal = /^["']([^"']+)["']$/.exec((match[2] ?? "").trim())
    if (literal === null) violations.push(`${where} calls ctx.get with a computed name; name the service`)
    else need(literal[1] ?? "", "gets")
  }
  for (const match of text.matchAll(ESCAPE))
    violations.push(`${where} reads ctx.${match[1]}, which reaches past the row's own services; inject what it needs`)
  if (DYNAMIC_IMPORT.test(text)) violations.push(`${where} imports a computed module name; import a string literal`)
  if (WORKERS_IMPORT.test(text) && !permitted.has("runtime"))
    violations.push(`${where} imports cloudflare:workers without the runtime permission in its package.json`)
  return violations
}
