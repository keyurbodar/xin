import { obj, oneOf, str } from "@earendil-works/pi-schema"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"
import { SKILLS, type CatalogSkill } from "./skills.ts"
import { THEMES, type CatalogTheme } from "./themes.ts"

const KINDS = ["skill", "theme"] as const
type Kind = (typeof KINDS)[number]

/** The bytes an entry's sha256 covers: a skill's markdown, or a theme's JSON with its keys sorted at every level. */
export function contentOf(entry: CatalogSkill | CatalogTheme): string {
  return "markdown" in entry ? entry.markdown : canonical(entry)
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const keyOf = (kind: Kind, id: string): string => `${kind}:${id}`

const skillSummary = ({ markdown, ...summary }: CatalogSkill) => ({ ...summary, lines: markdown.split("\n").length })

/** Zero storage reads or writes: the catalogue ships in the bundle, pinned by sha256 in lock.ts at build time, and every op answers from it. */
export function exploreOps(): readonly Op[] {
  const search = defineOp({
    name: "explore.search",
    read: true,
    args: obj({ kind: oneOf(KINDS) }),
    actors: ["owner"],
    run: async (_api, { kind }) =>
      kind === "skill" ? { kind, entries: SKILLS.map(skillSummary) } : { kind, entries: [...THEMES] },
  })

  const entry = defineOp({
    name: "explore.entry",
    read: true,
    args: obj({ kind: oneOf(KINDS), name: str({ maxLength: 80 }) }),
    actors: ["owner"],
    run: async (_api, { kind, name }) => {
      const found =
        kind === "skill" ? SKILLS.find((skill) => skill.name === name) : THEMES.find((theme) => theme.id === name)
      if (found === undefined) throw new OpRejected("bad_args", `no ${kind} ${name} in Explore`)
      return { kind, entry: found }
    },
  })

  return [search, entry]
}

export const catalogueKeys = (): readonly { readonly key: string; readonly content: string }[] => [
  ...SKILLS.map((skill) => ({ key: keyOf("skill", skill.name), content: contentOf(skill) })),
  ...THEMES.map((theme) => ({ key: keyOf("theme", theme.id), content: contentOf(theme) })),
]
