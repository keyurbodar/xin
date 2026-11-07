import type { ConversationId } from "@earendil-works/pi-durable"
import { type Static, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"

export const GOAL_OBJECTIVE_MAX = 4000
export const GOAL_REASON_MAX = 2000
export const GOAL_ID_PATTERN = "^g[0-9a-f]{12}$"

export const GoalPhaseSchema = oneOf(["active", "paused", "blocked", "complete"] as const)

export const GoalBlockerSchema = obj({
  code: str({ minLength: 1, maxLength: 64 }),
  reason: str({ minLength: 1, maxLength: GOAL_REASON_MAX }),
})

export const GoalSchema = obj({
  id: str({ pattern: GOAL_ID_PATTERN }),
  revision: int({ minimum: 1 }),
  objective: str({ minLength: 1, maxLength: GOAL_OBJECTIVE_MAX }),
  phase: GoalPhaseSchema,
  rounds: int({ minimum: 0 }),
  maxRounds: int({ minimum: 1 }),
  blocker: opt(GoalBlockerSchema),
  createdAt: int({ minimum: 0 }),
  updatedAt: int({ minimum: 0 }),
})

export type GoalPhase = Static<typeof GoalPhaseSchema>
export type GoalBlocker = Static<typeof GoalBlockerSchema>
export type Goal = Readonly<Static<typeof GoalSchema>>

export type GoalActivation = "armed" | "disarmed"

export type GoalView = Goal & { readonly activation: GoalActivation }

export type GoalSetRequest =
  | {
      readonly conversation: ConversationId
      readonly action: "create"
      readonly objective: string
      readonly maxRounds?: number
    }
  | {
      readonly conversation: ConversationId
      readonly action: "edit"
      readonly id: string
      readonly revision: number
      readonly objective?: string
      readonly maxRounds?: number
    }
  | {
      readonly conversation: ConversationId
      readonly action: "pause"
      readonly id: string
      readonly revision: number
    }
  | {
      readonly conversation: ConversationId
      readonly action: "resume"
      readonly id: string
      readonly revision: number
    }
  | {
      readonly conversation: ConversationId
      readonly action: "complete"
      readonly id: string
      readonly revision: number
    }
  | {
      readonly conversation: ConversationId
      readonly action: "clear"
      readonly id: string
      readonly revision: number
    }
  | {
      readonly conversation: ConversationId
      readonly action: "block"
      readonly id: string
      readonly revision: number
      readonly reason: string
    }

export type GoalOutcome =
  | { readonly kind: "ok"; readonly goal: GoalView | null }
  | { readonly kind: "stale_revision"; readonly goal: GoalView }
  | { readonly kind: "goal_exists"; readonly goal: GoalView }

export type GoalReservation = {
  readonly goal: GoalView
  readonly round: number
}

export type GoalAdmission =
  | { readonly kind: "admitted"; readonly goal: GoalView }
  | { readonly kind: "dropped"; readonly reason: string }

export class GoalRejected extends Error {}

export interface GoalsService {
  get(conversation: ConversationId): Promise<GoalView | null>
  set(request: GoalSetRequest): Promise<GoalOutcome>
  reserve(conversation: ConversationId): Promise<GoalReservation | null>
  admit(conversation: ConversationId, id: string, round: number): Promise<GoalAdmission>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    goals: GoalsService
  }
}
