import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { ID_SOURCE, SCHEDULE_FIELDS, type SchedulesService } from "../../src/contracts/schedules.ts"
import { type Context, OpRejected } from "../../src/kernel/index.ts"
import { RuleError } from "./rrule.ts"

const DEFAULT_TZ = "UTC"

export const name = "tool-schedules"
export const inject = ["pi", "schedules"]

export function apply(ctx: Context): void {
  ctx.pi.install(
    defineExtension({
      name: "tool-schedules",
      tools: [scheduleTool(ctx.schedules), unscheduleTool(ctx.schedules)],
    }),
  )
}

function scheduleTool(schedules: SchedulesService) {
  return defineTool({
    name: "schedule",
    description:
      "Create a prompt that arrives in this conversation later: a one-shot reminder with a time, or a recurrence with an rrule such as FREQ=DAILY;BYHOUR=9;BYMINUTE=0.",
    parameters: obj({ ...SCHEDULE_FIELDS, tz: opt(str({ minLength: 1, maxLength: 64 })) }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const created = await schedules.create(
          { ...args, tz: args.tz ?? DEFAULT_TZ },
          api.conversationId,
          api.now(),
          `call-${api.taskId}`,
        )
        return said(created.created ? `Scheduled ${created.id}.` : `Schedule ${created.id} is already running.`)
      } catch (error) {
        if (error instanceof OpRejected || error instanceof RuleError) return refused(error.message)
        throw error
      }
    },
  })
}

function unscheduleTool(schedules: SchedulesService) {
  return defineTool({
    name: "unschedule",
    description: "Cancel a schedule or reminder created with the schedule tool.",
    parameters: obj({ id: str({ pattern: ID_SOURCE }) }),
    replay: "safe",
    execute: async (args) => {
      const cancelled = await schedules.cancel(args.id)
      return said(cancelled ? `Cancelled ${args.id}.` : `No schedule ${args.id}.`)
    },
  })
}

function said(text: string) {
  return { output: [{ type: "text" as const, text }] }
}

function refused(reason: string) {
  return { output: [{ type: "text" as const, text: `Not scheduled: ${reason}.` }], isError: true }
}
