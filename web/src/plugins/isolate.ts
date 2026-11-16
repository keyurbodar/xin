import { createComponent, ErrorBoundary, type JSX } from "solid-js"
import type { ThemeChoice } from "../lib/theme.ts"
import { THEME_TOKENS, type ClientEntry, type PluginDef } from "./sdk.ts"

/**
 * Renders a plugin's component so that a throw while rendering, a throw on a later update and a rejected resource all
 * show `fallback` in its place, instead of reaching the screen's own boundary.
 */
export function contain(plugin: string, children: () => JSX.Element, fallback: () => JSX.Element): JSX.Element {
  return createComponent(ErrorBoundary, {
    fallback: (error: unknown) => {
      console.error(`plugin ${plugin} failed to render`, error)
      return fallback()
    },
    get children() {
      return children()
    },
  })
}

/** Loads each client module on its own: one that throws at import is logged and left out, and the others still load. */
export function loadEach(entries: readonly ClientEntry[], loaded: (name: string, plugin: PluginDef) => void): Promise<void> {
  return Promise.all(
    entries.map((entry) =>
      entry.load().then(
        (module) => loaded(entry.name, module.default),
        (error: unknown) => console.error(`plugin ${entry.name} failed to load`, error),
      ),
    ),
  ).then(() => undefined)
}

const KNOWN_TOKENS: ReadonlySet<string> = new Set(THEME_TOKENS)
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A plugin theme as the picker shows it, or undefined when the registration is malformed, which is logged and left out
 * so one bad theme never breaks Settings, the owner menu or the paint. Unknown tokens and non-string values are dropped.
 */
export function themeChoice(plugin: string, registration: unknown): ThemeChoice | undefined {
  const id: unknown = isRecord(registration) ? registration["id"] : undefined
  const label: unknown = isRecord(registration) ? registration["label"] : undefined
  const scheme: unknown = isRecord(registration) ? registration["scheme"] : undefined
  const tokens: unknown = isRecord(registration) ? registration["tokens"] : undefined
  if (
    typeof id !== "string" ||
    typeof label !== "string" ||
    (scheme !== "dark" && scheme !== "light") ||
    !isRecord(tokens)
  ) {
    console.error(`plugin ${plugin} registered a malformed theme`, registration)
    return undefined
  }
  const known = Object.entries(tokens).filter(
    (pair): pair is [string, string] => KNOWN_TOKENS.has(pair[0]) && typeof pair[1] === "string",
  )
  return { id, label, scheme, tokens: Object.fromEntries(known) }
}
