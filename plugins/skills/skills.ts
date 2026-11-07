import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { obj, str } from "@earendil-works/pi-schema"
import { createContributions } from "../../src/contributions.ts"
import { SKILL_NAME_PATTERN, type Skill, type SkillEntry, type SkillsService } from "../../src/contracts/skills.ts"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"

export const BUNDLED_SKILLS: readonly string[] = []

const NAME = new RegExp(SKILL_NAME_PATTERN)
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/
const SKILL_KEY = "skill:"

const unquote = (value: string): string =>
  value.length >= 2 &&
  ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value

export type ParsedSkill = { readonly ok: true; readonly skill: Skill } | { readonly ok: false; readonly error: string }

export function parseSkill(markdown: string): ParsedSkill {
  const match = FRONTMATTER.exec(markdown)
  if (match === null) return invalid("skill markdown must start with a --- frontmatter block")
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue
    const colon = line.indexOf(":")
    if (colon < 1) return invalid(`skill frontmatter line is not "key: value": ${line}`)
    fields.set(line.slice(0, colon).trim(), unquote(line.slice(colon + 1).trim()))
  }
  const name = fields.get("name")
  if (name === undefined || name === "") return invalid("skill frontmatter needs a name")
  if (!NAME.test(name)) return invalid(`skill name "${name}" must be lowercase letters, digits and hyphens`)
  const description = fields.get("description")
  if (description === undefined || description === "") return invalid(`skill "${name}" frontmatter needs a description`)
  return { ok: true, skill: { name, description, body: (match[2] ?? "").trim() } }
}

const invalid = (error: string): ParsedSkill => ({ ok: false, error })

export function skillOf(markdown: string): Skill {
  const parsed = parseSkill(markdown)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.skill
}

function parsePut(markdown: string): Skill {
  const parsed = parseSkill(markdown)
  if (!parsed.ok) throw new OpRejected("bad_args", parsed.error)
  return parsed.skill
}

export function skillsFrom(markdowns: readonly string[]): readonly Skill[] {
  const skills = new Map<string, Skill>()
  for (const markdown of markdowns) {
    const skill = skillOf(markdown)
    if (skills.has(skill.name)) throw new Error(`duplicate skill "${skill.name}"`)
    skills.set(skill.name, skill)
  }
  return [...skills.values()]
}

const byName = (left: Skill, right: Skill): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

async function ownerSkills(db: SqliteDatabase): Promise<readonly Skill[]> {
  const rows = await db.all<{ value: string }>("SELECT value FROM kv WHERE key LIKE 'skill:%'")
  return rows.map((row) => skillOf(row.value))
}

export type SkillsModule = {
  readonly service: SkillsService
  readonly ops: readonly Op[]
}

export function createSkills(db: SqliteDatabase): SkillsModule {
  const bundled = skillsFrom(BUNDLED_SKILLS)
  const contributed = createContributions<Skill>({
    key: (skill) => skill.name,
    label: (name) => `skill "${name}"`,
  })

  const loadSkills = async (): Promise<ReadonlyMap<string, SkillEntry>> => {
    const merged = new Map<string, SkillEntry>()
    for (const skill of bundled) merged.set(skill.name, { ...skill, source: { kind: "bundled" } })
    for (const { key, value, source } of contributed.entries())
      merged.set(key, { ...value, source: { kind: "row", row: source } })
    for (const skill of await ownerSkills(db)) merged.set(skill.name, { ...skill, source: { kind: "stored" } })
    return merged
  }

  const listSkills = async (): Promise<readonly SkillEntry[]> => [...(await loadSkills()).values()].toSorted(byName)

  const contribute = (skill: Skill, source: string): (() => void) => contributed.add(source, skill)

  const put: Op = defineOp({
    name: "skill.put",
    args: obj({ name: str({ pattern: SKILL_NAME_PATTERN }), markdown: str({ minLength: 1 }) }),
    actors: ["owner"],
    run: async (_api, { name, markdown }) => {
      const skill = parsePut(markdown)
      if (skill.name !== name)
        throw new OpRejected("bad_args", `skill frontmatter name "${skill.name}" does not match the put name "${name}"`)
      await db.run(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        `${SKILL_KEY}${name}`,
        markdown,
      )
      return { name: skill.name, description: skill.description }
    },
  })

  const remove: Op = defineOp({
    name: "skill.delete",
    args: obj({ name: str({ pattern: SKILL_NAME_PATTERN }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      await db.run("DELETE FROM kv WHERE key = ?", `${SKILL_KEY}${name}`)
      return { name }
    },
  })

  const list: Op = defineOp({
    name: "skill.list",
    args: obj({}),
    actors: ["owner"],
    run: async () => (await listSkills()).map(({ name, description }) => ({ name, description })),
  })

  const service: SkillsService = { list: listSkills, contribute }

  return { service, ops: [put, remove, list] }
}
