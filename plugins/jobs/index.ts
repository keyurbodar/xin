import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./jobs.ts"

export const { name, inject, apply } = hostModule("jobs", create)
