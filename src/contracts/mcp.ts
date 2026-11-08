import type { ToolRegistration } from "@earendil-works/pi-durable"

export type McpServerContribution = {
  readonly name: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface McpService {
  tools(): readonly ToolRegistration[]
  connect(server: McpServerContribution, source: string): Promise<() => void>
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
