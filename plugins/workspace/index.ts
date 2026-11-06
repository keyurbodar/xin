import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./workspace.ts"

export const { name, inject, apply } = hostModule("workspace", create, [])
