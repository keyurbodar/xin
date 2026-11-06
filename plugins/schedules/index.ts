import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./schedules.ts"

export const { name, inject, apply } = hostModule("schedules", create, ["intake"])
