import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./watchdog.ts"

export const { name, inject, apply } = hostModule("watchdog", create, ["intake", "jobs"])
