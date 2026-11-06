import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./memory.ts"

export const { name, inject, apply } = hostModule("memory", create)
