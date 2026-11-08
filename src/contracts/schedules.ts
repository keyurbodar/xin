import type { ConversationId } from "@earendil-works/pi-durable"
import { bool, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema"

export const ID_SOURCE = "^[A-Za-z0-9_-]{1,64}$"
export const MAX_TITLE = 120
export const MAX_PROMPT = 4_000
export const MAX_RULE = 512
export const DEFAULT_LIST_LIMIT = 100
export const MAX_LIST_LIMIT = 500

export const TARGET_CHOICES = ["this_session", "new_once", "new"] as const
export const TargetSchema = oneOf(TARGET_CHOICES)

export type ScheduleTargetChoice = (typeof TARGET_CHOICES)[number]

export type ScheduleErrorCode = "invalid_prompt" | "invalid_rule" | "invalid_selector" | "not_future"

export class ScheduleInputError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type ScheduleLastDelivery = {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly targetSessionId: number
}

export type ScheduleRunOutcome = "done" | "failed" | "running"

export type ScheduleRun = {
  readonly slot: string
  readonly deliveredAt: string
  readonly conversationId: number
  readonly outcome: ScheduleRunOutcome
}

export type ScheduleTask = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly rrule?: string
  readonly at?: string
  readonly target: ScheduleTargetChoice
  readonly active: boolean
  readonly nextAt: string | null
  readonly updatedAt: string
  readonly lastDelivery?: ScheduleLastDelivery
  readonly runs?: ScheduleRun[]
}

export type ScheduleNotFound = { readonly id: string; readonly code: "schedule_not_found" }
export type ScheduleConflict = { readonly id: string; readonly code: "schedule_conflict" }
export type ScheduleDeleted = { readonly id: string; readonly deleted: true }
export type ScheduleViewResult = ScheduleTask | ScheduleNotFound
export type ScheduleEditResult = ScheduleTask | ScheduleDeleted | ScheduleNotFound | ScheduleConflict

export type ScheduleListRequest = {
  readonly active?: boolean
  readonly limit?: number
  readonly offset?: number
  readonly outcomes?: boolean
}

export type ScheduleListPage = {
  readonly items: ScheduleTask[]
  readonly shown: number
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export type ScheduleCreateRequest = {
  readonly id?: string
  readonly title: string
  readonly prompt: string
  readonly rrule?: string
  readonly at?: number
  readonly tz?: string
  readonly target?: ScheduleTargetChoice
}

export type SchedulePatch = {
  readonly title?: string
  readonly prompt?: string
  readonly rrule?: string
  readonly target?: ScheduleTargetChoice
  readonly active?: boolean
}

export type ScheduleEditRequest =
  | {
      readonly id: string
      readonly action: "update"
      readonly patch: SchedulePatch
      readonly expectedUpdatedAt?: string
    }
  | { readonly id: string; readonly action: "delete"; readonly expectedUpdatedAt?: string }

export const SCHEDULE_EDIT_ACTIONS = ["update", "delete"] as const

const EDIT_STRING_MAX = 100

export const ScheduleEditArgsSchema = obj({
  id: str({ pattern: ID_SOURCE }),
  action: oneOf(SCHEDULE_EDIT_ACTIONS),
  title: opt(str({ minLength: 1, maxLength: MAX_TITLE })),
  prompt: opt(str({ minLength: 1, maxLength: MAX_PROMPT })),
  rrule: opt(str({ minLength: 1, maxLength: MAX_RULE })),
  target: opt(TargetSchema),
  active: opt(bool()),
  expectedUpdatedAt: opt(str({ minLength: 1, maxLength: EDIT_STRING_MAX })),
})

export type ScheduleEditArgs = Static<typeof ScheduleEditArgsSchema>

export function editRequest(args: ScheduleEditArgs): ScheduleEditRequest {
  const expected = args.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: args.expectedUpdatedAt }
  if (args.action === "delete") {
    const patched = [args.title, args.prompt, args.rrule, args.target, args.active].some((field) => field !== undefined)
    if (patched)
      throw new ScheduleInputError("invalid_selector", "delete accepts only id, action, and expectedUpdatedAt.")
    return { id: args.id, action: "delete", ...expected }
  }
  const patch: SchedulePatch = {
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
    ...(args.rrule === undefined ? {} : { rrule: args.rrule }),
    ...(args.target === undefined ? {} : { target: args.target }),
    ...(args.active === undefined ? {} : { active: args.active }),
  }
  if (Object.keys(patch).length === 0)
    throw new ScheduleInputError(
      "invalid_selector",
      "update requires at least one of title, prompt, rrule, target, or active.",
    )
  return { id: args.id, action: "update", patch, ...expected }
}

export type CreatedSchedule = {
  readonly id: string
  readonly created: boolean
  readonly task: ScheduleTask
}

export interface SchedulesService {
  create(
    request: ScheduleCreateRequest,
    fallback: ConversationId,
    now: number,
    defaultId: string,
  ): Promise<CreatedSchedule>
  cancel(id: string): Promise<boolean>
  view(id: string): Promise<ScheduleViewResult>
  list(request: ScheduleListRequest): Promise<ScheduleListPage>
  edit(request: ScheduleEditRequest, fallback: ConversationId, now: number): Promise<ScheduleEditResult>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    schedules: SchedulesService
  }
}
