import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  type ConversationId,
  defineExtension,
  defineTask,
  type EntryId,
  GenerationTask,
  type Harness,
  hook,
  runEndTask,
  type Task,
} from "@earendil-works/pi-durable"
import type { IntakeService } from "../../src/contracts/intake.ts"
import type { GoalsService, GoalView } from "../../src/contracts/goals.ts"
import { messageSendTarget } from "../../src/contracts/message.ts"
import type { Context, OpCall } from "../../src/kernel/index.ts"

export const name = "goal-rounds"
export const inject = ["pi", "goals", "intake", "clock", "harness", "host"]

export const ROUND_TASK = "xin.goal.round"
export const ROUND_COMMAND = "goal:"
const PENDING_COMMAND = "goal.pending."

const COMMAND = /^goal:(g[0-9a-f]{12}):([1-9][0-9]*):([1-9][0-9]*)$/

export type RoundsPorts = {
  readonly goals: GoalsService
  readonly intake: IntakeService
  readonly harness: Harness
  readonly kv: SyncKvStorage
  arm(): Promise<void>
}

type RoundInput = {
  readonly target: number
  readonly goalId: string
  readonly commandId: string
  readonly text: string
}

type RoundState = { readonly phase: "send" }

export function apply(ctx: Context): void {
  const ports: RoundsPorts = {
    goals: ctx.goals,
    intake: ctx.intake,
    harness: ctx.harness,
    kv: ctx.host.state.storage.kv,
    arm: () => ctx.clock.arm(),
  }
  const task = roundTask(ports)

  ctx.pi.install(
    defineExtension({
      name: "goal-rounds",
      tasks: [task],
      hooks: [
        hook(GenerationTask, {
          afterRun: async (run, api) => {
            const reservation = await ports.goals.reserve(api.conversationId)
            if (reservation === null) return undefined
            const commandId = commandIdOf(reservation.goal.id, reservation.round, run.last)
            ports.kv.put(pendingKey(api.conversationId), commandId)
            return {
              tasks: [
                runEndTask(task, {
                  target: api.conversationId,
                  goalId: reservation.goal.id,
                  commandId,
                  text: renderGoalRoundPrompt(reservation.goal, reservation.round),
                }),
              ],
            }
          },
        }),
      ],
    }),
  )

  ctx.on("intake/batch", async (batch, next) => {
    const first = batch.rows[0]
    if (first === undefined) return next()
    const found = parseCommandId(first.commandId)
    if (found === undefined) return next()
    const admission = await ports.goals.admit(batch.target, found.id, found.round)
    if (admission.kind === "dropped") {
      forget(ports, batch.target, first.commandId)
      return { kind: "dropped", reason: `goal: ${admission.reason}` }
    }
    forget(ports, batch.target, first.commandId)
    const text = renderGoalRoundPrompt(admission.goal, found.round)
    for (const row of batch.rows) {
      if (parseCommandId(row.commandId) !== undefined) row.text = text
    }
    return next()
  })

  ctx.on("ops/before", async (call, next) => {
    const target = await ownerMessageTarget(ports, call)
    if (target !== undefined) await withdraw(ports, target)
    return next()
  })
}

export function commandIdOf(goalId: string, round: number, run: EntryId): string {
  return `${ROUND_COMMAND}${goalId}:${round}:${run}`
}

export function parseCommandId(
  commandId: string,
): { readonly id: string; readonly round: number; readonly run: number } | undefined {
  const match = COMMAND.exec(commandId)
  if (match === null) return undefined
  const id = match[1]
  const round = match[2]
  const run = match[3]
  if (id === undefined || round === undefined || run === undefined) return undefined
  return { id, round: Number(round), run: Number(run) }
}

export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
  return (
    "<goal_round>\n" +
    `Objective: ${JSON.stringify(goal.objective)}\n` +
    `Round: ${round}/${goal.maxRounds}\n\n` +
    "Continue working toward the objective in this same session. Treat the current workspace, " +
    "tool results, and durable session state as authoritative; inspect them instead of assuming " +
    "earlier narration is still current. Make concrete progress and verify the result. Before " +
    "claiming completion, gather evidence that the whole objective is achieved, read the current " +
    "goal, and mark it complete. If work remains, leave the goal active for the next round. Follow " +
    "the configured goal-tool policy before reporting a blocker.\n" +
    "</goal_round>"
  )
}

export function roundTask(ports: RoundsPorts): Task<RoundInput, RoundState, null, object> {
  return defineTask<RoundInput, RoundState, null, object>({
    name: ROUND_TASK,
    version: 1,
    initial: () => ({ phase: "send" }),
    phases: {
      send: async (task, runtime, context) => {
        const delivered = await ports.intake.enqueue({
          target: task.input.target as ConversationId,
          commandId: task.input.commandId,
          kind: "job",
          threadId: task.input.goalId,
          title: "Goal round",
          status: "running",
          text: task.input.text,
        })
        if (delivered) await ports.arm()
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const,
          context,
        )
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, context),
  })
}

function pendingKey(conversation: ConversationId): string {
  return `${PENDING_COMMAND}${conversation}`
}

function forget(ports: RoundsPorts, conversation: ConversationId, commandId: string | undefined): void {
  const key = pendingKey(conversation)
  const held: unknown = ports.kv.get(key)
  if (typeof held !== "string") {
    if (held !== undefined) ports.kv.delete(key)
    return
  }
  if (commandId !== undefined && held !== commandId) return
  ports.kv.delete(key)
}

async function withdraw(ports: RoundsPorts, conversation: ConversationId): Promise<void> {
  const key = pendingKey(conversation)
  const held: unknown = ports.kv.get(key)
  if (typeof held !== "string") {
    if (held !== undefined) ports.kv.delete(key)
    return
  }
  await ports.intake.withdraw(held)
  ports.kv.delete(key)
}

async function ownerMessageTarget(ports: RoundsPorts, call: OpCall): Promise<ConversationId | undefined> {
  if (call.command.op !== "message.send" || call.actor.kind !== "owner") return undefined
  const target = messageSendTarget(call.command.args)
  if (target === undefined) return undefined
  switch (target.kind) {
    case "conversation":
      return target.conversation
    case "root":
      return (await ports.harness.root(BACKGROUND_CONTEXT)).id
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}
