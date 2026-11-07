import type { JsonValue } from "@earendil-works/chord"
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import {
  GOAL_OBJECTIVE_MAX,
  GOAL_REASON_MAX,
  GoalRejected,
  type GoalOutcome,
  type GoalView,
} from "../../src/contracts/goals.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-goals"
export const inject = ["pi", "goals"]

const POLICY =
  "create_goal may infer goal intent from a direct human request in any language. After session resume or fork, " +
  "an active goal is disarmed: when a human asks to continue or resume in any wording or language, use " +
  "update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark " +
  "blocked only after the same blocking condition persists for at least 3 consecutive goal rounds, and report " +
  "that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked."

const CREATE_DESCRIPTION =
  "Create a persisted goal that keeps this conversation working across automatic continuation rounds. " +
  'Use it when the direct human request is a long-running objective, even if the user did not say "goal"; ' +
  "not for single-turn work."

const GET_DESCRIPTION = "Read the current conversation goal, including the id and revision that update_goal requires."

const UPDATE_ACTIONS = ["edit", "pause", "resume", "complete", "blocked"] as const

const answer = async (outcome: Promise<GoalOutcome>) => {
  try {
    return goalResult(await outcome)
  } catch (error) {
    if (error instanceof GoalRejected) return textResult(error.message, { isError: true })
    throw error
  }
}

export function apply(ctx: Context): void {
  const goals = ctx.goals
  ctx.pi.install(
    defineExtension({
      name: "tool-goals",
      sections: [section("goal-policy", () => POLICY)],
      tools: [
        defineTool({
          name: "get_goal",
          description: GET_DESCRIPTION,
          parameters: obj({}),
          replay: "safe",
          execute: async (_args, api) => textResult(JSON.stringify(goalValue(await goals.get(api.conversationId)))),
        }),
        defineTool({
          name: "create_goal",
          description: CREATE_DESCRIPTION,
          parameters: obj({
            objective: str({
              minLength: 1,
              maxLength: GOAL_OBJECTIVE_MAX,
              description: "The concrete completion objective inferred from the direct human request.",
            }),
            max_goal_rounds: opt(int({ minimum: 1, description: "Optional limit on automatic continuation rounds." })),
          }),
          execute: async (args, api) =>
            answer(
              goals.set({
                conversation: api.conversationId,
                action: "create",
                objective: args.objective,
                ...(args.max_goal_rounds === undefined ? {} : { maxRounds: args.max_goal_rounds }),
              }),
            ),
        }),
        defineTool({
          name: "update_goal",
          description:
            "Update the current goal. Call get_goal first and pass its exact id and revision. " +
            "action edit, pause, and resume need a direct human request; complete and blocked are also " +
            "allowed during an automatic goal round. blocked_reason is required for blocked and ignored otherwise; " +
            "objective and max_goal_rounds affect only edit.",
          parameters: obj({
            goal_id: str({ minLength: 1, description: "Exact id returned by get_goal." }),
            revision: int({ minimum: 1, description: "Exact positive revision returned by get_goal." }),
            action: oneOf(UPDATE_ACTIONS),
            objective: opt(
              str({
                maxLength: GOAL_OBJECTIVE_MAX,
                description: "Replacement objective; valid only with action edit.",
              }),
            ),
            max_goal_rounds: opt(int({ minimum: 0, description: "Replacement cap; valid only with action edit." })),
            blocked_reason: opt(
              str({
                maxLength: GOAL_REASON_MAX,
                description: "Required only with action blocked: the concrete condition that blocks progress.",
              }),
            ),
          }),
          execute: async (args, api) => {
            const ref = { conversation: api.conversationId, id: args.goal_id, revision: args.revision }
            switch (args.action) {
              case "edit":
                return answer(
                  goals.set({
                    ...ref,
                    action: "edit",
                    ...(hasText(args.objective) ? { objective: args.objective } : {}),
                    ...(hasRoundCap(args.max_goal_rounds) ? { maxRounds: args.max_goal_rounds } : {}),
                  }),
                )
              case "pause":
                return answer(goals.set({ ...ref, action: "pause" }))
              case "resume":
                return answer(goals.set({ ...ref, action: "resume" }))
              case "complete":
                return answer(goals.set({ ...ref, action: "complete" }))
              case "blocked": {
                const reason = args.blocked_reason
                if (!hasText(reason))
                  return textResult("blocked_reason is required with action blocked", { isError: true })
                return answer(goals.set({ ...ref, action: "block", reason }))
              }
              default: {
                const _exhaustive: never = args.action
                return textResult(`unknown action ${String(_exhaustive)}`, { isError: true })
              }
            }
          },
        }),
      ],
    }),
  )
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

function goalResult(outcome: GoalOutcome) {
  switch (outcome.kind) {
    case "ok":
      return textResult(JSON.stringify(goalValue(outcome.goal)))
    case "stale_revision":
      return textResult(
        `stale_revision: goal ${outcome.goal.id} is at revision ${outcome.goal.revision}; read it again with get_goal.`,
        { isError: true },
      )
    case "goal_exists":
      return textResult(
        `goal_exists: goal ${outcome.goal.id} is ${outcome.goal.phase}; finish, block, or clear it first.`,
        { isError: true },
      )
  }
}

function goalValue(goal: GoalView | null): JsonValue {
  if (goal === null) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.rounds,
      maxGoalRounds: goal.maxRounds,
      ...(goal.blocker === undefined
        ? {}
        : { blockedReason: { code: goal.blocker.code, message: goal.blocker.reason } }),
    },
    activation: goal.activation,
  }
}
