import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./files.ts"

export const { name, inject, apply } = hostModule("files", create, [])
