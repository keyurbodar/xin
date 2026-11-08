import type { Context } from "@deepseek-ai/cordis"
import type { Catalog } from "../../src/kernel/loader.ts"
import type { DeployRequest, Deployed } from "../../src/kernel/system.ts"

export const DEPLOYED_PACKAGES = "k-deployed-packages"

const recorder = {
  name: "k-package-deployer",
  inject: ["host"],
  apply(ctx: Context) {
    ctx.provide("deployer", {
      deploy: async (request: DeployRequest): Promise<Deployed> => {
        ctx.host.state.storage.kv.put(DEPLOYED_PACKAGES, request.packages)
        return { application: "deploying", detail: "recorded" }
      },
    })
  },
}

export const catalog: Catalog = {
  "k-package-deployer": {
    plugin: recorder,
    title: "Recording deployer",
    description: "Records the packages an update asked to deploy.",
    source: "test",
  },
  "k-package-weather": {
    plugin: recorder,
    title: "Recorded package",
    description: "A package name a test can install or uninstall.",
    source: "xin-plugin-weather@1.0.0",
  },
}
