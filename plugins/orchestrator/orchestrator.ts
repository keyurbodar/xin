import { defineExtension } from "@earendil-works/pi-durable"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { threadService } from "./service.ts"
import { lifecycle } from "./threads.ts"

export function create(deps: ModuleDeps): HostModule {
  const threads = lifecycle(deps)
  return {
    provides: { threads: threadService(deps, threads) },
    extensions: [defineExtension({ name: "xin.orchestrator", tasks: [threads.anchor, threads.reporter] })],
    ops: threads.ops,
  }
}
