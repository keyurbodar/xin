import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { int, obj, opt } from "@earendil-works/pi-schema"
import { JobsDoc, type JobRecord } from "../../src/contracts/jobs.ts"
import { defineOp, type Op } from "../../src/ops.ts"

const context = BACKGROUND_CONTEXT
const MAX_LISTED = 100

export type JobState = "running" | "completed" | "failed"

export type JobView = {
  readonly id: number
  readonly tool: string
  readonly title: string
  readonly parentId: number
  readonly startedAt: number
  readonly deadlineAt: number
  readonly detached: boolean
  readonly state: JobState
  readonly result?: string
}

function stateOf(job: JobRecord): JobState {
  if (job.result === undefined) return "running"
  return job.result.isError ? "failed" : "completed"
}

export function listJobsOp(): Op {
  return defineOp({
    name: "job.list",
    args: obj({ limit: opt(int({ minimum: 1, maximum: MAX_LISTED })) }),
    actors: ["owner"],
    run: async (api, args) => {
      const doc = await api.harness.snapshot(JobsDoc, context)
      const jobs: JobView[] = Object.entries(doc?.jobs ?? {}).map(([id, job]) => ({
        id: Number(id),
        tool: job.tool,
        title: job.title,
        parentId: job.parentId,
        startedAt: job.startedAt,
        deadlineAt: job.deadlineAt,
        detached: job.detached === true,
        state: stateOf(job),
        ...(job.result === undefined ? {} : { result: job.result.text }),
      }))
      return { jobs: jobs.toSorted((left, right) => right.startedAt - left.startedAt).slice(0, args.limit ?? MAX_LISTED) }
    },
  })
}
