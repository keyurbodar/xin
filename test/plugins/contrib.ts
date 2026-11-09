import { rowId } from "../../src/contributions.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

export const catalog: Catalog = {
  contrib: {
    plugin: {
      name: "contrib",
      inject: ["skills", "prompts"],
      apply(ctx) {
        const row = rowId(ctx)
        ctx.skills.contribute(
          { name: "contrib-skill", description: "A contributed skill.", body: "Do the contributed thing." },
          row,
        )
        ctx.prompts.contribute(
          { name: "contrib-prompt", description: "A contributed prompt.", text: "Contributed prompt text." },
          row,
        )
      },
    },
    title: "Contributions",
    description: "test plugin contrib",
    source: "test",
  },
}

export const rows = [{ id: "contrib", name: "cordis:contrib" }]
