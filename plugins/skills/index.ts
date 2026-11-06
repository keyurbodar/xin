import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./skills.ts"

export const { name, inject, apply } = hostModule("skills", create)
