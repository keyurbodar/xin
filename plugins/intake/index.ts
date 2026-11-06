import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./gateway.ts"

export const { name, inject, apply } = hostModule("intake", create, [])
