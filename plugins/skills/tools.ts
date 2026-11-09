import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import type { ConversationId } from "@earendil-works/pi-durable"
import { obj, str } from "@earendil-works/pi-schema"
import { presetAllows } from "../../src/contracts/presets.ts"
import { SKILL_NAME_PATTERN, type SkillEntry } from "../../src/contracts/skills.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-skills"
export const inject = ["pi", "skills", "kernel"]

function suggestions(given: string, known: readonly string[]): readonly string[] {
  return known.filter(
    (other) =>
      other.startsWith(given) ||
      given.startsWith(other) ||
      (Math.abs(other.length - given.length) <= 2 && other.charAt(0) === given.charAt(0)),
  )
}

export function apply(ctx: Context): void {
  /** Skills the conversation's preset keeps: a stored or bundled skill always, a row's skill only when its plugin is named. */
  const visible = async (conversationId: ConversationId): Promise<readonly SkillEntry[]> => {
    const preset = ctx.get("presets")?.presetOf(conversationId)
    return (await ctx.skills.list()).filter(
      (entry) => entry.source.kind !== "row" || presetAllows(preset, ctx.kernel.pluginOfRow(entry.source.row)),
    )
  }

  const skillsSection = section("skills", async (input) => {
    const skills = await visible(input.conversationId)
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
    execute: async ({ name: requested }, api) => {
      const skills = await visible(api.conversationId)
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
