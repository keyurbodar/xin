import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./questions.ts"

export const { name, inject, apply } = hostModule("questions", create)
