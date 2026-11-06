import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./failures.ts"

export const { name, inject, apply } = hostModule("failures", create)
