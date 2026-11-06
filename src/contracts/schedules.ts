import type { ConversationId } from "@earendil-works/pi-durable"
import { int, opt, str } from "@earendil-works/pi-schema"

export const ID_SOURCE = "^[A-Za-z0-9_-]{1,64}$"

export const SCHEDULE_FIELDS = {
  id: opt(str({ pattern: ID_SOURCE })),
  rrule: opt(str({ minLength: 1, maxLength: 512 })),
  at: opt(int({ minimum: 0 })),
  tz: str({ minLength: 1, maxLength: 64 }),
  prompt: str({ minLength: 1, maxLength: 4000 }),
  conv: opt(int({ minimum: 0 })),
  projectId: opt(str({ minLength: 1, maxLength: 64 })),
}

export type ScheduleRequest = {
  readonly id?: string
  readonly rrule?: string
  readonly at?: number
  readonly tz: string
  readonly prompt: string
  readonly conv?: number
  readonly projectId?: string
}

export type CreatedSchedule = {
  readonly id: string
  readonly created: boolean
}

export interface SchedulesService {
  create(request: ScheduleRequest, fallback: ConversationId, now: number, defaultId: string): Promise<CreatedSchedule>
  cancel(id: string): Promise<boolean>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    schedules: SchedulesService
  }
}
