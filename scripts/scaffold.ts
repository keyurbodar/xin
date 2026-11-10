export type Template = {
  readonly manifest: string
  readonly module: string
  readonly test: string
}

export type ScaffoldFile = { readonly path: string; readonly content: string }

/** The plugin name inside `plugins/hello`, the one word a scaffold rewrites. */
export const TEMPLATE = "hello"

const NAME = /^[a-z][a-z0-9-]*$/

const title = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

/**
 * The files `bun scripts/xin.ts plugin new <name>` writes into `plugins/<name>`, from the
 * template package's own sources. Pure, so the authoring test can scaffold without a disk.
 */
export function scaffold(name: string, template: Template): readonly ScaffoldFile[] {
  if (!NAME.test(name))
    throw new Error(
      `plugin name "${name}" must be lowercase letters, digits and hyphens, starting with a letter, like "hello-world"`,
    )
  const rename = (text: string): string => text.replaceAll(TEMPLATE, name).replaceAll(title(TEMPLATE), title(name))
  return [
    { path: "package.json", content: rename(template.manifest) },
    { path: "index.ts", content: rename(template.module) },
    { path: `${name}.test.ts`, content: rename(template.test) },
  ]
}
