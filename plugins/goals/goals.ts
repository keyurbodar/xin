import type { ConversationId } from "@earendil-works/pi-durable"
import { compile } from "@earendil-works/pi-schema"
import {
  GOAL_OBJECTIVE_MAX,
  GOAL_REASON_MAX,
  GoalSchema,
  GoalRejected,
  type Goal,
  type GoalActivation,
  type GoalAdmission,
  type GoalBlocker,
  type GoalOutcome,
  type GoalPhase,
  type GoalReservation,
  type GoalSetRequest,
  type GoalView,
  type GoalsService,
} from "../../src/contracts/goals.ts"

const ROUND_LIMIT = "round-limit"
const MODEL_REPORTED = "model-reported"
const PLAN = compile(GoalSchema)

export type GoalsPort = {
  readonly kv: SyncKvStorage
  readonly defaultMaxRounds: number
}

const keyOf = (conversation: ConversationId): string => `goal.${conversation}`

const later = (goal: Goal): number => Math.max(Date.now(), goal.updatedAt)

type Transition = {
  readonly objective?: string
  readonly phase?: GoalPhase
  readonly rounds?: number
  readonly maxRounds?: number
  readonly blocker?: GoalBlocker
  readonly clearBlocker?: true
}

type Arm = GoalActivation | "keep"

export function createGoals(port: GoalsPort): GoalsService {
  const armed = new Set<number>()

  const read = (conversation: ConversationId): Goal | undefined => {
    const stored: unknown = port.kv.get(keyOf(conversation))
    if (stored === undefined) return undefined
    if (!PLAN.check(stored)) throw new Error(`goal.${conversation} is not a valid goal`)
    return stored
  }

  const write = (conversation: ConversationId, goal: Goal): void => {
    port.kv.put(keyOf(conversation), goal)
  }

  const setActivation = (conversation: ConversationId, arm: Arm): void => {
    if (arm === "armed") armed.add(conversation)
    else if (arm === "disarmed") armed.delete(conversation)
  }

  const transition = (conversation: ConversationId, goal: Goal, change: Transition, arm: Arm): Goal => {
    const { clearBlocker, ...rest } = change
    const blocker = clearBlocker === true ? undefined : (change.blocker ?? goal.blocker)
    const next: { -readonly [K in keyof Goal]: Goal[K] } = {
      ...goal,
      ...rest,
      revision: goal.revision + 1,
      updatedAt: later(goal),
    }
    if (blocker === undefined) delete next.blocker
    else next.blocker = blocker
    setActivation(conversation, arm)
    return next
  }

  const view = (conversation: ConversationId, goal: Goal): GoalView => ({
    ...goal,
    activation: armed.has(conversation) ? "armed" : "disarmed",
  })

  const current = (conversation: ConversationId): Goal => {
    const goal = read(conversation)
    if (goal === undefined) throw new GoalRejected("no goal is set")
    return goal
  }

  const expected = (conversation: ConversationId, id: string, revision: number): Goal | undefined => {
    const goal = current(conversation)
    if (goal.id !== id || goal.revision !== revision) return undefined
    return goal
  }

  const stale = (conversation: ConversationId): GoalOutcome => ({
    kind: "stale_revision",
    goal: view(conversation, current(conversation)),
  })

  const blockAtCap = (conversation: ConversationId, goal: Goal): void => {
    write(
      conversation,
      transition(
        conversation,
        goal,
        { phase: "blocked", blocker: { code: ROUND_LIMIT, reason: limitReason(goal.maxRounds) } },
        "disarmed",
      ),
    )
  }

  const create = (request: Extract<GoalSetRequest, { action: "create" }>): GoalOutcome => {
    const { conversation } = request
    const objective = resolveObjective(request.objective)
    const maxRounds = resolveMaxRounds(request.maxRounds ?? port.defaultMaxRounds)
    const existing = read(conversation)
    if (existing !== undefined && existing.phase !== "complete") {
      return { kind: "goal_exists", goal: view(conversation, existing) }
    }
    const now = Date.now()
    const goal: Goal = {
      id: newGoalId(),
      revision: 1,
      objective,
      phase: "active",
      rounds: 0,
      maxRounds,
      createdAt: now,
      updatedAt: now,
    }
    write(conversation, goal)
    setActivation(conversation, "armed")
    return { kind: "ok", goal: view(conversation, goal) }
  }

  const edit = (request: Extract<GoalSetRequest, { action: "edit" }>): GoalOutcome => {
    const { conversation } = request
    const found = expected(conversation, request.id, request.revision)
    if (found === undefined) return stale(conversation)
    if (request.objective === undefined && request.maxRounds === undefined) {
      throw new GoalRejected("goal edit requires objective or maxRounds")
    }
    const goal = transition(
      conversation,
      found,
      {
        ...(request.objective === undefined ? {} : { objective: resolveObjective(request.objective) }),
        ...(request.maxRounds === undefined ? {} : { maxRounds: resolveMaxRounds(request.maxRounds) }),
      },
      "keep",
    )
    write(conversation, goal)
    return { kind: "ok", goal: view(conversation, goal) }
  }

  const pause = (request: Extract<GoalSetRequest, { action: "pause" }>): GoalOutcome => {
    const { conversation } = request
    const found = expected(conversation, request.id, request.revision)
    if (found === undefined) return stale(conversation)
    if (found.phase !== "active") throw new GoalRejected(`cannot pause a goal in phase "${found.phase}"`)
    const goal = transition(conversation, found, { phase: "paused" }, "disarmed")
    write(conversation, goal)
    return { kind: "ok", goal: view(conversation, goal) }
  }

  const resume = (request: Extract<GoalSetRequest, { action: "resume" }>): GoalOutcome => {
    const { conversation } = request
    const found = expected(conversation, request.id, request.revision)
    if (found === undefined) return stale(conversation)
    if (found.phase === "complete") throw new GoalRejected(`cannot resume a complete goal`)
    if (found.rounds >= found.maxRounds) {
      throw new GoalRejected(
        `goal "${found.id}" exhausted ${found.maxRounds} goal rounds; increase maxRounds before resuming`,
      )
    }
    if (found.phase === "active" && armed.has(conversation)) {
      throw new GoalRejected(`goal "${found.id}" is already active and armed`)
    }
    const goal = transition(conversation, found, { phase: "active", clearBlocker: true }, "armed")
    write(conversation, goal)
    return { kind: "ok", goal: view(conversation, goal) }
  }

  const complete = (request: Extract<GoalSetRequest, { action: "complete" }>): GoalOutcome => {
    const { conversation } = request
    const found = expected(conversation, request.id, request.revision)
    if (found === undefined) return stale(conversation)
    if (found.phase === "complete") throw new GoalRejected(`goal "${found.id}" is already complete`)
    const goal = transition(conversation, found, { phase: "complete" }, "disarmed")
    write(conversation, goal)
    return { kind: "ok", goal: view(conversation, goal) }
  }

  const block = (request: Extract<GoalSetRequest, { action: "block" }>): GoalOutcome => {
    const { conversation } = request
    const found = expected(conversation, request.id, request.revision)
    if (found === undefined) return stale(conversation)
    if (found.phase !== "active") throw new GoalRejected(`cannot block a goal in phase "${found.phase}"`)
    const reason = request.reason.trim()
    if (reason.length === 0) throw new GoalRejected("a goal block requires a non-empty reason")
    if (reason.length > GOAL_REASON_MAX)
      throw new GoalRejected(`a goal block reason is at most ${GOAL_REASON_MAX} characters`)
    const goal = transition(
      conversation,
      found,
      { phase: "blocked", blocker: { code: MODEL_REPORTED, reason } },
      "disarmed",
    )
    write(conversation, goal)
    return { kind: "ok", goal: view(conversation, goal) }
  }

  const clear = (request: Extract<GoalSetRequest, { action: "clear" }>): GoalOutcome => {
    const { conversation } = request
    const found = expected(conversation, request.id, request.revision)
    if (found === undefined) return stale(conversation)
    port.kv.delete(keyOf(conversation))
    setActivation(conversation, "disarmed")
    return { kind: "ok", goal: null }
  }

  return {
    get: async (conversation) => {
      const goal = read(conversation)
      return goal === undefined ? null : view(conversation, goal)
    },

    set: async (request) => {
      switch (request.action) {
        case "create":
          return create(request)
        case "edit":
          return edit(request)
        case "pause":
          return pause(request)
        case "resume":
          return resume(request)
        case "complete":
          return complete(request)
        case "block":
          return block(request)
        case "clear":
          return clear(request)
        default: {
          const _exhaustive: never = request
          throw new Error(`unhandled goal action ${JSON.stringify(_exhaustive)}`)
        }
      }
    },

    reserve: async (conversation): Promise<GoalReservation | null> => {
      const goal = read(conversation)
      if (goal === undefined || goal.phase !== "active" || !armed.has(conversation)) return null
      if (goal.rounds >= goal.maxRounds) {
        blockAtCap(conversation, goal)
        return null
      }
      return { goal: view(conversation, goal), round: goal.rounds + 1 }
    },

    admit: async (conversation, id, round): Promise<GoalAdmission> => {
      const goal = read(conversation)
      if (goal === undefined) return { kind: "dropped", reason: "no goal is set" }
      if (goal.id !== id) return { kind: "dropped", reason: "the goal changed" }
      if (goal.phase !== "active") return { kind: "dropped", reason: `the goal is ${goal.phase}` }
      if (!armed.has(conversation)) return { kind: "dropped", reason: "the goal is disarmed" }
      if (goal.rounds >= goal.maxRounds) return { kind: "dropped", reason: "the goal has no rounds left" }
      if (round !== goal.rounds + 1) return { kind: "dropped", reason: "the reservation is stale" }
      const rounds = goal.rounds + 1
      const capped = rounds >= goal.maxRounds
      const next = capped
        ? transition(
            conversation,
            goal,
            { phase: "blocked", rounds, blocker: { code: ROUND_LIMIT, reason: limitReason(goal.maxRounds) } },
            "disarmed",
          )
        : transition(conversation, goal, { rounds }, "keep")
      write(conversation, next)
      return { kind: "admitted", goal: view(conversation, next) }
    },
  }
}

function resolveObjective(value: string): string {
  const objective = value.trim()
  if (objective.length === 0 || objective.length > GOAL_OBJECTIVE_MAX) {
    throw new GoalRejected(`a goal objective is 1-${GOAL_OBJECTIVE_MAX} characters`)
  }
  return objective
}

function resolveMaxRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new GoalRejected("maxRounds must be a positive safe integer")
  return value
}

function limitReason(maxRounds: number): string {
  return `Goal reached its configured limit of ${maxRounds} rounds.`
}

function newGoalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `g${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
