import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./push.ts"

export const { name, inject, apply } = hostModule("push", create)
