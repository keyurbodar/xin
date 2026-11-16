export type Template = {
  readonly manifest: string
  readonly module: string
  readonly test: string
  readonly client: string
}

export type ScaffoldFile = { readonly path: string; readonly content: string }

/** The plugin name inside `plugins/hello`, the one word a scaffold rewrites. */
export const TEMPLATE = "hello"

const NAME = /^[a-z][a-z0-9-]*$/

const title = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

/** The manifest without its web half: no `client` module and no `slots`. */
function serverOnly(manifest: string): string {
  const parsed: unknown = JSON.parse(manifest)
  const plugins: unknown = Reflect.get(Object(Reflect.get(Object(parsed), "ingle")), "plugins")
  for (const entry of Object.values(Object(plugins))) {
    Reflect.deleteProperty(Object(entry), "client")
    Reflect.deleteProperty(Object(entry), "slots")
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}

/**
 * The files `bun scripts/ingle.ts plugin new <name> [--client]` writes into `plugins/<name>`, from the
 * template package's own sources. With `client` the package keeps the template's web module and its
 * slots; without it the package is server-only. Pure, so the authoring test can scaffold without a disk.
 */
export function scaffold(
  name: string,
  template: Template,
  options: { readonly client: boolean },
): readonly ScaffoldFile[] {
  if (!NAME.test(name))
    throw new Error(
      `plugin name "${name}" must be lowercase letters, digits and hyphens, starting with a letter, like "hello-world"`,
    )
  const rename = (text: string): string => text.replaceAll(TEMPLATE, name).replaceAll(title(TEMPLATE), title(name))
  return [
    { path: "package.json", content: rename(options.client ? template.manifest : serverOnly(template.manifest)) },
    { path: "index.ts", content: rename(template.module) },
    { path: `${name}.test.ts`, content: rename(template.test) },
    ...(options.client ? [{ path: "client.tsx", content: rename(template.client) }] : []),
  ]
}
