import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./orchestrator.ts"

export const { name, inject, apply } = hostModule("orchestrator", create, ["pi", "intake", "watchdog", "models"])
