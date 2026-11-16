import { expect, test } from "bun:test"
import type { McpServer } from "../state/extensions.ts"
import type { ModelInfo, ProviderSummary } from "../state/settings.ts"
import { providerDetail, providerStatus, serverDetail, serverStatus, STATUS_LABEL } from "./integrations.ts"

const model: ModelInfo = {
  provider: "acme",
  modelId: "acme-1",
  name: "Acme 1",
  contextWindow: 0,
  vision: false,
  reasoning: false,
  thinking: ["off"],
  keyed: true,
  cost: undefined,
}

const provider = (...models: readonly ModelInfo[]): ProviderSummary => ({ id: "acme", models })

const server = (fields: Partial<McpServer> = {}): McpServer => ({ name: "ats", url: "https://mcp.example.com", tools: 3, ...fields })

test("a provider is connected until a save or remove fails", () => {
  expect(providerStatus(undefined)).toBe("connected")
  expect(providerStatus("rejected")).toBe("error")
})

test("the provider detail counts its models", () => {
  expect(providerDetail(provider(model))).toBe("1 model · stored sealed")
  expect(providerDetail(provider(model, model))).toBe("2 models · stored sealed")
})

test("a server is connected until it reports an error", () => {
  expect(serverStatus(server())).toBe("connected")
  expect(serverStatus(server({ error: "401 Unauthorized" }))).toBe("error")
})

test("the server detail is its error, else its tools and source", () => {
  expect(serverDetail(server({ tools: 1 }))).toBe("1 tool")
  expect(serverDetail(server({ source: "github" }))).toBe("3 tools · from github")
  expect(serverDetail(server({ error: "401 Unauthorized" }))).toBe("401 Unauthorized")
})

test("every status has a label", () => {
  expect(STATUS_LABEL).toEqual({ connected: "Connected", error: "Error" })
})
