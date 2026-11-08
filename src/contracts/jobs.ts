import type { Context as ChordContext } from "@earendil-works/chord"
import type { Models } from "@earendil-works/pi-ai"
import {
  defineDoc,
  type ConversationId,
  type JsonObject,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { bool, compile, int, map, num, obj, opt, str, type Static } from "@earendil-works/pi-schema"

export const JobSchema = obj({
  tool: str({ minLength: 1 }),
  title: str({ minLength: 1 }),
  startedAt: num(),
  deadlineAt: num(),
  parentId: int({ minimum: 0 }),
  detached: opt(bool()),
  result: opt(obj({ text: str(), isError: bool(), details: opt(obj({}, { open: true })) }, { open: true })),
})
export const JobsSchema = obj({ jobs: map(JobSchema), calls: opt(map(int({ minimum: 0 }))) })

export type JobRecord = Static<typeof JobSchema>
export type JobsState = Static<typeof JobsSchema>

export const parseJobs = compile(JobsSchema)

export const JobsDoc = defineDoc<JobsState>({
  kind: "xin.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {} }),
  checkpointWhen: () => false,
})

export type JobRun = {
  readonly signal: AbortSignal
  readonly models: Models
  now(): number
  env(): Promise<ExecutionEnv | undefined>
}

export type JobWork = (args: JsonObject, run: JobRun, context: ChordContext) => Promise<ToolExecutionResult>

export type JobTool = Omit<ToolRegistration, "execute">

export interface JobsService {
  tool(tool: JobTool, work: JobWork): ToolRegistration
  isJobTool(name: string): boolean
  cancel(callerId: ConversationId, jobId: number): Promise<boolean>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    jobs: JobsService
  }
}
