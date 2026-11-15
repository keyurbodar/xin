import { defineExtension, section, type Extension } from "@earendil-works/pi-durable"
import type { ThreadsService } from "../../src/contracts/threads.ts"
import type { Op } from "../../src/ops.ts"
import { threadCache } from "./cache.ts"
import { captainOps, captainPrompt, type CaptainDeps } from "./captains.ts"
import { threadService, type ServiceDeps } from "./service.ts"
import { lifecycle, type ThreadDeps } from "./threads.ts"

export type OrchestratorDeps = ServiceDeps & ThreadDeps & CaptainDeps

export type Orchestrator = {
  readonly threads: ThreadsService
  readonly extension: Extension
  readonly ops: readonly Op[]
}

export function create(deps: OrchestratorDeps): Orchestrator {
  const threads = lifecycle(deps)
  return {
    threads: threadService(deps, threads),
    extension: defineExtension({
      name: "xin.orchestrator",
      tasks: [threads.anchor, threads.reporter],
      hooks: [threadCache],
      sections: [section("captain", (input) => captainPrompt(input.read, input.conversationId))],
    }),
    ops: [...threads.ops, ...captainOps(deps)],
  }
}
