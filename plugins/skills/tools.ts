import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import { obj, str } from "@earendil-works/pi-schema"
import { SKILL_NAME_PATTERN } from "../../src/contracts/skills.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-skills"
export const inject = ["pi", "skills"]

function suggestions(given: string, known: readonly string[]): readonly string[] {
  return known.filter(
    (other) =>
      other.startsWith(given) ||
      given.startsWith(other) ||
      (Math.abs(other.length - given.length) <= 2 && other.charAt(0) === given.charAt(0)),
  )
}

export function apply(ctx: Context): void {
  const skillsSection = section("skills", async () => {
    const skills = await ctx.skills.list()
    if (skills.length === 0) return undefined
    return [
      "Load a skill's full instructions with skill(name).",
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    ].join("\n")
  })

  const skillTool = defineTool({
    name: "skill",
    description: "Load the full instructions of a skill listed in the skills section.",
    parameters: obj({ name: str({ pattern: SKILL_NAME_PATTERN }) }),
    replay: "safe",
    execute: async ({ name: requested }) => {
      const skills = await ctx.skills.list()
      const skill = skills.find((other) => other.name === requested)
      if (skill !== undefined) return textResult(skill.body)
      const known = skills.map((other) => other.name)
      const close = suggestions(requested, known)
      const hint =
        close.length > 0
          ? ` Did you mean ${close.map((other) => `"${other}"`).join(" or ")}?`
          : known.length > 0
            ? ` Known skills: ${known.join(", ")}.`
            : ""
      return textResult(`No skill "${requested}".${hint}`, { isError: true })
    },
  })

  ctx.pi.install(defineExtension({ name: "tool-skills", tools: [skillTool], sections: [skillsSection] }))
}
