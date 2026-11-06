import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./models.ts"

export const { name, inject, apply } = hostModule("models", create, [])
