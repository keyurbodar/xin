import type { JsonValue } from "@earendil-works/chord"
import type { ConversationId } from "@earendil-works/pi-durable"
import { type Static, int, lit, obj, opt, str, union } from "@earendil-works/pi-schema"
import {
  GOAL_ID_PATTERN,
  GOAL_OBJECTIVE_MAX,
  GOAL_REASON_MAX,
  GoalRejected,
  type GoalSetRequest,
  type GoalView,
  type GoalsService,
} from "../../src/contracts/goals.ts"
import { type Context, type Op, OpRejected, Schema, defineOp } from "../../src/kernel/index.ts"
import { createGoals } from "./goals.ts"

export const name = "goals"
export const inject = ["host", "ops"]

export const Config = Schema.object({
  defaultMaxRounds: Schema.number()
    .min(1)
    .step(1)
    .default(256)
    .description("Rounds a goal gets when its create request names none."),
})

type Config = { readonly defaultMaxRounds: number }

const ID = str({ pattern: GOAL_ID_PATTERN })
const REVISION = int({ minimum: 1 })
const OBJECTIVE = str({ minLength: 1, maxLength: GOAL_OBJECTIVE_MAX })
const MAX_ROUNDS = int({ minimum: 1 })
const REASON = str({ minLength: 1, maxLength: GOAL_REASON_MAX })
const TARGET = { conversation: int({ minimum: 0 }) }

const SET_ARGS = union([
  obj({ ...TARGET, action: lit("create"), objective: OBJECTIVE, maxRounds: opt(MAX_ROUNDS) }),
  obj({
    ...TARGET,
    action: lit("edit"),
    id: ID,
    revision: REVISION,
    objective: opt(OBJECTIVE),
    maxRounds: opt(MAX_ROUNDS),
  }),
  obj({ ...TARGET, action: lit("pause"), id: ID, revision: REVISION }),
  obj({ ...TARGET, action: lit("resume"), id: ID, revision: REVISION }),
  obj({ ...TARGET, action: lit("complete"), id: ID, revision: REVISION }),
  obj({ ...TARGET, action: lit("block"), id: ID, revision: REVISION, reason: REASON }),
  obj({ ...TARGET, action: lit("clear"), id: ID, revision: REVISION }),
])

const GET_ARGS = obj(TARGET)

export function apply(ctx: Context, config: Config): void {
  const maxRounds = config.defaultMaxRounds
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new TypeError("defaultMaxRounds must be a positive safe integer")
  }
  const goals = createGoals({ kv: ctx.host.state.storage.kv, defaultMaxRounds: maxRounds })
  ctx.provide("goals", goals)
  for (const op of goalOps(goals)) ctx.ops.define(op)
}

export function goalOps(goals: GoalsService): readonly Op[] {
  return [
    defineOp({
      name: "goal.get",
      args: GET_ARGS,
      actors: ["owner", "agent"],
      run: async (_api, args) => ({
        goal: await guarded(async () => {
          const goal = await goals.get(conversationOf(args.conversation))
          return goal === null ? null : goalJson(goal)
        }),
      }),
    }),
    defineOp({
      name: "goal.set",
      args: SET_ARGS,
      actors: ["owner", "agent"],
      run: async (_api, args) => guarded(async () => outcomeJson(await goals.set(requestOf(args)))),
    }),
  ]
}

const conversationOf = (conversation: number): ConversationId => conversation as ConversationId

function requestOf(args: Static<typeof SET_ARGS>): GoalSetRequest {
  const conversation = conversationOf(args.conversation)
  switch (args.action) {
    case "create":
      return {
        conversation,
        action: "create",
        objective: args.objective,
        ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
      }
    case "edit":
      return {
        conversation,
        action: "edit",
        id: args.id,
        revision: args.revision,
        ...(args.objective === undefined ? {} : { objective: args.objective }),
        ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
      }
    case "pause":
      return { conversation, action: "pause", id: args.id, revision: args.revision }
    case "resume":
      return { conversation, action: "resume", id: args.id, revision: args.revision }
    case "complete":
      return { conversation, action: "complete", id: args.id, revision: args.revision }
    case "clear":
      return { conversation, action: "clear", id: args.id, revision: args.revision }
    case "block":
      return { conversation, action: "block", id: args.id, revision: args.revision, reason: args.reason }
    default: {
      const _exhaustive: never = args
      throw new Error(`unhandled goal action ${JSON.stringify(_exhaustive)}`)
    }
  }
}

function goalJson(goal: GoalView): JsonValue {
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    rounds: goal.rounds,
    maxRounds: goal.maxRounds,
    ...(goal.blocker === undefined ? {} : { blocker: { code: goal.blocker.code, reason: goal.blocker.reason } }),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    activation: goal.activation,
  }
}

function outcomeJson(outcome: {
  readonly kind: "ok" | "stale_revision" | "goal_exists"
  readonly goal: GoalView | null
}): JsonValue {
  return { kind: outcome.kind, goal: outcome.goal === null ? null : goalJson(outcome.goal) }
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof GoalRejected) throw new OpRejected("bad_args", error.message)
    throw error
  }
}
