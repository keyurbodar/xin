import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"
import { catalogueKeys, sha256 } from "./explore.ts"
import { SHA256 } from "./lock.ts"
import { SKILLS } from "./skills.ts"
import { THEMES } from "./themes.ts"

const HEX = /^#[0-9a-f]{6}$/u

describe("explore", () => {
  it("pins a sha256 for exactly the bundled entries, and every pin matches its content", async () => {
    const keys = catalogueKeys()
    expect(Object.keys(SHA256).toSorted()).toEqual(keys.map(({ key }) => key).toSorted())
    for (const { key, content } of keys) expect(await sha256(content), key).toBe(SHA256[key])
  })

  it("ships skills that skill.put accepts and themes with a hex palette for each variant", async () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(6)
    expect(THEMES.length).toBeGreaterThanOrEqual(8)
    for (const theme of THEMES)
      for (const palette of [theme.dark, theme.light])
        expect(Object.values(palette).every((colour) => HEX.test(colour)), theme.id).toBe(true)
    const stub = fresh()
    const skill = SKILLS[0]
    if (skill === undefined) throw new Error("no skills bundled")
    await cmd(stub, "explore-put", "skill.put", { name: skill.name, markdown: skill.markdown })
    expect((await cmd(stub, "explore-skills", "skill.list")).result).toContainEqual({
      name: skill.name,
      description: skill.description,
    })
  })

  it("searches by kind, query and category, without bodies in skill results", async () => {
    const stub = fresh()
    const skills = (await cmd(stub, "explore-s1", "explore.search", { kind: "skill" })).result
    expect(skills).toMatchObject({ kind: "skill", entries: SKILLS.map(({ name }) => expect.objectContaining({ name })) })
    expect(JSON.stringify(skills)).not.toContain("---\nname:")

    const warm = (await cmd(stub, "explore-s2", "explore.search", { kind: "theme", category: "Warm" })).result
    expect(warm).toMatchObject({
      entries: THEMES.filter((theme) => theme.category === "Warm").map(({ id }) => expect.objectContaining({ id })),
    })

    const found = (await cmd(stub, "explore-s3", "explore.search", { kind: "skill", query: "RELEASE" })).result
    expect(found).toEqual({ kind: "skill", entries: [expect.objectContaining({ name: "release-notes" })] })

    const none = (await cmd(stub, "explore-s4", "explore.search", { kind: "theme", query: "zzz-nothing" })).result
    expect(none).toEqual({ kind: "theme", entries: [] })
  })

  it("returns an entry with its pinned sha256, and refuses an unknown one", async () => {
    const stub = fresh()
    const theme = await cmd(stub, "explore-e1", "explore.entry", { kind: "theme", name: "fjord" })
    expect(theme.result).toEqual({
      kind: "theme",
      entry: THEMES.find((entry) => entry.id === "fjord"),
      sha256: SHA256["theme:fjord"],
    })
    const missing = await cmd(stub, "explore-e2", "explore.entry", { kind: "skill", name: "nope" })
    expect(missing).toMatchObject({ ok: false })
  })
})
