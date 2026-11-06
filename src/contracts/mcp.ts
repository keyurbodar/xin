import type { ToolRegistration } from "@earendil-works/pi-durable"

export interface McpService {
  tools(): readonly ToolRegistration[]
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    mcp: McpService
  }

  interface Events {
    /** @mode emit. The model-facing set of MCP tools changed. */
    "mcp/changed"(): void
  }
}
