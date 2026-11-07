import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { obj, str } from "@earendil-works/pi-schema"
import { SKILL_NAME_PATTERN, type Skill, type SkillsService } from "../../src/contracts/skills.ts"
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

function parseSkill(markdown: string): Skill {
  const match = FRONTMATTER.exec(markdown)
  if (match === null) throw new Error("skill markdown must start with a --- frontmatter block")
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue
    const colon = line.indexOf(":")
    if (colon < 1) throw new Error(`skill frontmatter line is not "key: value": ${line}`)
    fields.set(line.slice(0, colon).trim(), unquote(line.slice(colon + 1).trim()))
  }
  const name = fields.get("name")
  if (name === undefined || name === "") throw new Error("skill frontmatter needs a name")
  if (!NAME.test(name)) throw new Error(`skill name "${name}" must be lowercase letters, digits and hyphens`)
  const description = fields.get("description")
  if (description === undefined || description === "")
    throw new Error(`skill "${name}" frontmatter needs a description`)
  return { name, description, body: (match[2] ?? "").trim() }
}

function parsePut(markdown: string): Skill {
  try {
    return parseSkill(markdown)
  } catch (error) {
    throw new OpRejected("bad_args", error instanceof Error ? error.message : String(error))
  }
}

export function skillsFrom(markdowns: readonly string[]): readonly Skill[] {
  const skills = new Map<string, Skill>()
  for (const markdown of markdowns) {
    const skill = parseSkill(markdown)
    if (skills.has(skill.name)) throw new Error(`duplicate skill "${skill.name}"`)
    skills.set(skill.name, skill)
  }
  return [...skills.values()]
}

const byName = (left: Skill, right: Skill): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

async function ownerSkills(db: SqliteDatabase): Promise<readonly Skill[]> {
  const rows = await db.all<{ value: string }>("SELECT value FROM kv WHERE key LIKE 'skill:%'")
  return rows.map((row) => parseSkill(row.value))
}

export type SkillsModule = {
  readonly service: SkillsService
  readonly ops: readonly Op[]
}

export function createSkills(db: SqliteDatabase): SkillsModule {
  const bundled = skillsFrom(BUNDLED_SKILLS)

  const loadSkills = async (): Promise<ReadonlyMap<string, Skill>> => {
    const merged = new Map(bundled.map((skill) => [skill.name, skill]))
    for (const skill of await ownerSkills(db)) merged.set(skill.name, skill)
    return merged
  }

  const listSkills = async (): Promise<readonly Skill[]> => [...(await loadSkills()).values()].toSorted(byName)

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

  const service: SkillsService = { list: listSkills }

  return { service, ops: [put, remove, list] }
}
