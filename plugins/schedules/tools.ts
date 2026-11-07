import type { Context as ToolContext } from "@earendil-works/chord"
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import {
  DEFAULT_LIST_LIMIT,
  editRequest,
  MAX_LIST_LIMIT,
  MAX_PROMPT,
  MAX_RULE,
  MAX_TITLE,
  ScheduleInputError,
  type SchedulesService,
  TARGET_CHOICES,
} from "../../src/contracts/schedules.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-schedules"
export const inject = ["pi", "schedules"]

const MANAGEMENT_AUTHORIZATION =
  "Only create or modify scheduled tasks at the user's explicit request; " +
  "prior explicit authorization for the running scheduled task remains valid."

const SUBAGENT_REFUSAL = "A delegated subagent cannot use scheduled tasks."

const CREATE_DESCRIPTION =
  "Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target conversation " +
  "as a scheduled message from the user. The result includes the task id and the next occurrence as nextAt. " +
  "After downtime, only the latest missed occurrence is delivered. Delivery can repeat after a crash."

const LIST_DESCRIPTION =
  "List scheduled tasks, including tasks created from other conversations. Active tasks come first, ordered by nextAt."

const VIEW_DESCRIPTION = "View one scheduled task by id."

const EDIT_DESCRIPTION =
  "Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages."

const TITLE_HELP =
  `Task name of at most ${MAX_TITLE} characters in the user's language: action plus object. ` +
  "Omit timing, status, ids, and bracketed suffixes."

const RRULE_HELP =
  "One DTSTART line, a newline, and one RRULE line. DTSTART is YYYYMMDDTHHMMSS, ending in Z for UTC or " +
  "carrying TZID with an IANA time zone, for example DTSTART;TZID=Europe/Berlin:20260901T080000. " +
  "A TZID rule keeps local clock time across daylight-saving changes. " +
  "Supported frequencies are HOURLY, DAILY, WEEKLY and MONTHLY. " +
  "Supported parts are FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYHOUR and BYMINUTE; HOURLY takes BYMINUTE only, " +
  "and UNTIL is a UTC instant ending in Z. A one-time delivery is RRULE:FREQ=DAILY;COUNT=1. " +
  'Example: "DTSTART;TZID=Europe/Berlin:20260901T080000\\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0"'

const TARGET_HELP =
  "this_session delivers to this conversation; new_once delivers to the same new conversation every time, " +
  "opened at the first delivery; new opens a different new conversation for every delivery. " +
  "Use this_session for reminders and follow-ups to this conversation; use new_once or new for independent work, " +
  "such as a recurring report, and whenever the user asks for a new conversation."

export function apply(ctx: Context): void {
  const schedules = ctx.schedules
  ctx.pi.install(
    defineExtension({
      name: "tool-schedules",
      tools: [createTool(schedules), listTool(schedules), viewTool(schedules), editTool(schedules)],
      sections: [section("schedule", () => MANAGEMENT_AUTHORIZATION)],
    }),
  )
}

function createTool(schedules: SchedulesService) {
  return defineTool({
    name: "schedule_create",
    description: CREATE_DESCRIPTION,
    parameters: obj({
      title: str({ minLength: 1, maxLength: MAX_TITLE, description: TITLE_HELP }),
      prompt: str({ minLength: 1, maxLength: MAX_PROMPT, description: "Instruction delivered at each occurrence." }),
      rrule: str({ minLength: 1, maxLength: MAX_RULE, description: RRULE_HELP }),
      target: oneOf(TARGET_CHOICES, { description: TARGET_HELP }),
    }),
    replay: "safe",
    execute: (args, api, context) =>
      runTool(api, context, async () => {
        const created = await schedules.create(
          { title: args.title, prompt: args.prompt, rrule: args.rrule, target: args.target },
          api.conversationId,
          api.now(),
          `call-${api.taskId}`,
        )
        return created.task
      }),
  })
}

function listTool(schedules: SchedulesService) {
  return defineTool({
    name: "schedule_list",
    description: LIST_DESCRIPTION,
    parameters: obj({
      active: opt(
        bool({
          description: "true for active tasks only; false for paused and ended tasks only; omitted for all tasks.",
        }),
      ),
      limit: opt(
        int({
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: `Page size from 1 to ${MAX_LIST_LIMIT}; defaults to ${DEFAULT_LIST_LIMIT}.`,
        }),
      ),
      offset: opt(int({ minimum: 0, description: "Number of tasks to skip; defaults to 0." })),
    }),
    replay: "safe",
    execute: (args, api, context) =>
      runTool(api, context, () =>
        schedules.list({
          ...(args.active === undefined ? {} : { active: args.active }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.offset === undefined ? {} : { offset: args.offset }),
        }),
      ),
  })
}

function viewTool(schedules: SchedulesService) {
  return defineTool({
    name: "schedule_view",
    description: VIEW_DESCRIPTION,
    parameters: obj({ id: str({ minLength: 1, maxLength: 64, description: "Task id." }) }),
    replay: "safe",
    execute: (args, api, context) => runTool(api, context, () => schedules.view(args.id)),
  })
}

function editTool(schedules: SchedulesService) {
  return defineTool({
    name: "schedule_edit",
    description: EDIT_DESCRIPTION,
    parameters: obj({
      id: str({ minLength: 1, maxLength: 64, description: "Task id." }),
      action: oneOf(["update", "delete"] as const, {
        description: "update applies the provided fields, at least one; delete removes the task.",
      }),
      title: opt(str({ minLength: 1, maxLength: MAX_TITLE, description: TITLE_HELP })),
      prompt: opt(
        str({ minLength: 1, maxLength: MAX_PROMPT, description: "New instruction delivered at each occurrence." }),
      ),
      rrule: opt(
        str({ minLength: 1, maxLength: MAX_RULE, description: "New recurrence in the schedule_create rrule format." }),
      ),
      target: opt(
        oneOf(TARGET_CHOICES, {
          description:
            "Omit to retain the destination. Providing target replaces it; new_once reserves a different conversation. " +
            "Choices are the same as schedule_create.",
        }),
      ),
      active: opt(
        bool({
          description:
            "false pauses the task; true resumes only if its timing has a future occurrence. " +
            "Otherwise provide a new rrule.",
        }),
      ),
      expectedUpdatedAt: opt(
        str({
          minLength: 1,
          maxLength: 100,
          description:
            "updatedAt from the latest result that returned this task; if the task changed after that result, " +
            "the result is schedule_conflict and nothing changes.",
        }),
      ),
    }),
    replay: "safe",
    execute: (args, api, context) =>
      runTool(api, context, () => schedules.edit(editRequest(args), api.conversationId, api.now())),
  })
}

async function runTool(
  api: ToolExecutionApi,
  context: ToolContext,
  run: () => Promise<unknown>,
): Promise<ToolExecutionResult> {
  const thread = await api.snapshot(ThreadDoc, api.conversationId, context)
  if (thread !== undefined) return json({ code: "subagent_session", message: SUBAGENT_REFUSAL })
  try {
    return json(await run())
  } catch (error) {
    if (error instanceof ScheduleInputError) return json({ code: error.code, message: error.message })
    return json({ code: "internal_error", message: "The schedule operation failed." })
  }
}

function json(value: unknown): ToolExecutionResult {
  return textResult(JSON.stringify(value))
}
