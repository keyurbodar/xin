import type { McpServer } from "../state/extensions.ts"
import type { ProviderSummary } from "../state/settings.ts"
import type { SignalState } from "./status.ts"

export type IntegrationStatus = "connected" | "needs-key" | "error"

export const STATUS_LABEL: Readonly<Record<IntegrationStatus, string>> = {
  connected: "Connected",
  "needs-key": "Needs key",
  error: "Error",
}

export const STATUS_SIGNAL: Readonly<Record<IntegrationStatus, SignalState>> = {
  connected: "done",
  "needs-key": "needs",
  error: "failed",
}

const count = (value: number, word: string): string => `${value} ${word}${value === 1 ? "" : "s"}`

export function providerStatus(provider: ProviderSummary, failure: string | undefined): IntegrationStatus {
  if (failure !== undefined) return "error"
  return provider.models.length > 0 && provider.models.every((model) => model.keyed) ? "connected" : "needs-key"
}

export function providerDetail(provider: ProviderSummary): string {
  return `${count(provider.models.length, "model")} · stored sealed`
}

export function serverStatus(server: McpServer): IntegrationStatus {
  return server.error === undefined ? "connected" : "error"
}

export function serverDetail(server: McpServer): string {
  if (server.error !== undefined) return server.error
  const tools = count(server.tools, "tool")
  return server.source === undefined ? tools : `${tools} · from ${server.source}`
}
