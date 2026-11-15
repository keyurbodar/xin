import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { obj, str } from "@earendil-works/pi-schema"
import { createContributions } from "../../src/contributions.ts"
import type { ConversationId } from "@earendil-works/pi-durable"
import type { DriveService } from "../../src/contracts/drive.ts"
import { SKILL_NAME_PATTERN, type Skill, type SkillEntry, type SkillsService } from "../../src/contracts/skills.ts"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"

const BUNDLED_SKILLS: readonly string[] = []

const NAME = new RegExp(SKILL_NAME_PATTERN)
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/
/** Skills `skill.put` stored in `kv` before they lived in the user's Drive; `moveToDrive` moves them once. */
const LEGACY_FROM = "skill:"
const LEGACY_TO = "skill;"
const skillPath = (name: string): string => `skills/${name}/SKILL.md`

const unquote = (value: string): string =>
  value.length >= 2 &&
  ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value

export type ParsedSkill = { readonly ok: true; readonly skill: Skill } | { readonly ok: false; readonly error: string }

function parseSkill(markdown: string): ParsedSkill {
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

function skillOf(markdown: string): Skill {
  const parsed = parseSkill(markdown)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.skill
}

function parsePut(markdown: string): Skill {
  const parsed = parseSkill(markdown)
  if (!parsed.ok) throw new OpRejected("bad_args", parsed.error)
  return parsed.skill
}

function skillsFrom(markdowns: readonly string[]): readonly Skill[] {
  const skills = new Map<string, Skill>()
  for (const markdown of markdowns) {
    const skill = skillOf(markdown)
    if (skills.has(skill.name)) throw new Error(`duplicate skill "${skill.name}"`)
    skills.set(skill.name, skill)
  }
  return [...skills.values()]
}

const byName = (left: Skill, right: Skill): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

const toMarkdown = (skill: Skill): string =>
  `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n`

export async function moveToDrive(db: SqliteDatabase, drive: DriveService): Promise<void> {
  const rows = await db.all<{ key: string; value: string }>(
    "SELECT key, value FROM kv WHERE key >= ? AND key < ?",
    LEGACY_FROM,
    LEGACY_TO,
  )
  for (const row of rows) {
    await drive.write({ kind: "user" }, skillPath(row.key.slice(LEGACY_FROM.length)), row.value)
    await db.run("DELETE FROM kv WHERE key = ?", row.key)
  }
}

export type SkillsModule = {
  readonly service: SkillsService
  readonly ops: readonly Op[]
}

/** Bundled and row skills, plus the `skills/<name>/SKILL.md` files the Drive installs per scope. */
export function createSkills(drive: DriveService): SkillsModule {
  const bundled = skillsFrom(BUNDLED_SKILLS)
  const contributed = createContributions<Skill>({
    key: (skill) => skill.name,
    label: (name) => `skill "${name}"`,
  })

  const loadSkills = async (conversationId?: ConversationId): Promise<ReadonlyMap<string, SkillEntry>> => {
    const merged = new Map<string, SkillEntry>()
    for (const skill of bundled) merged.set(skill.name, { ...skill, source: { kind: "bundled" } })
    for (const { key, value, source } of contributed.entries())
      merged.set(key, { ...value, source: { kind: "row", row: source } })
    for (const file of await drive.skills(conversationId)) {
      const parsed = parseSkill(file.markdown)
      if (!parsed.ok || parsed.skill.name !== file.name) continue
      merged.set(file.name, { ...parsed.skill, source: { kind: "drive", scope: file.scope }, markdown: file.markdown })
    }
    return merged
  }

  const listSkills = async (conversationId?: ConversationId): Promise<readonly SkillEntry[]> =>
    [...(await loadSkills(conversationId)).values()].toSorted(byName)

  const contribute = (skill: Skill, source: string): (() => void) => contributed.add(source, skill)

  const put: Op = defineOp({
    name: "skill.put",
    args: obj({ name: str({ pattern: SKILL_NAME_PATTERN }), markdown: str({ minLength: 1 }) }),
    actors: ["owner"],
    run: async (_api, { name, markdown }) => {
      const skill = parsePut(markdown)
      if (skill.name !== name)
        throw new OpRejected("bad_args", `skill frontmatter name "${skill.name}" does not match the put name "${name}"`)
      await drive.write({ kind: "user" }, skillPath(name), markdown)
      return { name: skill.name, description: skill.description }
    },
  })

  const remove: Op = defineOp({
    name: "skill.delete",
    args: obj({ name: str({ pattern: SKILL_NAME_PATTERN }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      await drive.remove({ kind: "user" }, skillPath(name))
      return { name }
    },
  })

  const list: Op = defineOp({
    name: "skill.list",
    read: true,
    args: obj({}),
    actors: ["owner"],
    run: async () => (await listSkills()).map(({ name, description }) => ({ name, description })),
  })

  const read: Op = defineOp({
    name: "skill.read",
    read: true,
    args: obj({ name: str({ pattern: SKILL_NAME_PATTERN }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      const entry = (await loadSkills()).get(name)
      if (entry === undefined) throw new OpRejected("bad_args", `no skill ${name}`)
      return { name: entry.name, description: entry.description, markdown: entry.markdown ?? toMarkdown(entry) }
    },
  })

  const service: SkillsService = { list: listSkills, contribute }

  return { service, ops: [put, remove, list, read] }
}
