import type { ToolRegistration } from "@earendil-works/pi-durable"

export interface McpService {
  tools(): readonly ToolRegistration[]
  watch(listener: () => void): () => void
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    mcp: McpService
  }
}
