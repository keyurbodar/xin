import { hostModule } from "../../src/kernel/index.ts"
import { create } from "./mcp.ts"

export const { name, inject, apply } = hostModule("mcp", create, ["jobs"])
