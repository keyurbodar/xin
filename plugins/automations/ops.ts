import { arr, bool, int, lit, map, nullable, obj, opt, str, union } from "@earendil-works/pi-schema"
import { defineOp, type Op, type OpApi, OpRejected } from "../../src/ops.ts"
import {
  AutomationError,
  type AutomationView,
  type Caller,
  type Engine,
  MAX_PROMPT,
  MAX_RULES,
  MAX_TITLE,
  MAX_TRIGGERS,
  withoutSecrets,
} from "./automations.ts"

const ID = "^[A-Za-z0-9_.:-]{1,128}$"
const MAX_RUNS = 50

const RuleSchema = obj({
  when: opt(map(str({ maxLength: 512 }))),
  groupBy: opt(arr(str({ minLength: 1, maxLength: 128 }), { maxItems: 8 })),
  count: opt(nullable(int({ minimum: 1, maximum: 50 }))),
  maxWaitSeconds: opt(nullable(int({ minimum: 1, maximum: 7 * 24 * 3600 }))),
  quietSeconds: opt(nullable(int({ minimum: 1, maximum: 7 * 24 * 3600 }))),
})

const TriggerSchema = union([
  obj({
    kind: lit("schedule"),
    cron: str({ minLength: 9, maxLength: 128 }),
    tz: opt(str({ minLength: 1, maxLength: 64 })),
  }),
  obj({ kind: lit("once"), at: str({ minLength: 1, maxLength: 64 }) }),
  obj({
    kind: lit("webhook"),
    id: opt(str({ minLength: 1, maxLength: 64 })),
    contains: opt(arr(str({ minLength: 1, maxLength: 256 }), { maxItems: 10 })),
    regex: opt(str({ minLength: 1, maxLength: 256 })),
    rules: opt(arr(RuleSchema, { maxItems: MAX_RULES })),
  }),
])

export const targetSchema = (description?: string) =>
  union(
    [obj({ kind: lit("fresh") }), obj({ kind: lit("same"), threadId: opt(int({ minimum: 0 })) })],
    description === undefined ? {} : { description },
  )

export const triggersSchema = (description?: string) =>
  arr(TriggerSchema, { maxItems: MAX_TRIGGERS, ...(description === undefined ? {} : { description }) })

const TargetSchema = targetSchema()
const TriggersSchema = triggersSchema()
export const Title = str({ minLength: 1, maxLength: MAX_TITLE })
export const Prompt = str({ minLength: 1, maxLength: MAX_PROMPT })
export const Project = str({ minLength: 1, maxLength: 128 })

const CreateArgs = obj({
  title: Title,
  prompt: Prompt,
  project: opt(Project),
  target: opt(TargetSchema),
  triggers: TriggersSchema,
  enabled: opt(bool()),
})

const UpdateArgs = obj({
  id: str({ pattern: ID }),
  title: opt(Title),
  prompt: opt(Prompt),
  project: opt(Project),
  target: opt(TargetSchema),
  triggers: opt(TriggersSchema),
  enabled: opt(bool()),
})

const IdArgs = obj({ id: str({ pattern: ID }) })

const TriggerArgs = obj({ id: str({ pattern: ID }), input: opt(str({ minLength: 1, maxLength: 16_384 })) })

const GetArgs = obj({ id: str({ pattern: ID }), runs: opt(int({ minimum: 0, maximum: MAX_RUNS })) })

const RunsArgs = obj({
  id: str({ pattern: ID }),
  limit: opt(int({ minimum: 1, maximum: MAX_RUNS })),
  before: opt(str({ minLength: 1, maxLength: 64 })),
})

const ACTORS = ["owner", "agent"] as const

export function callerOf(api: OpApi): Caller {
  return api.actor.kind === "agent" ? { conversationId: api.actor.conversationId } : {}
}

/** Webhook secrets go to the owner only; an agent's op result reaches the model. */
const shown = <T extends AutomationView>(api: OpApi, view: T): T =>
  api.actor.kind === "agent" ? withoutSecrets(view) : view

/** A stable id from the command id, so a resent create returns the automation the first one made. */
export function stableId(source: string): string {
  const cleaned = source.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128)
  return cleaned === "" ? crypto.randomUUID() : cleaned
}

export async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AutomationError)
      throw new OpRejected(error.code === "subagent_session" ? "forbidden" : "bad_args", error.message)
    throw error
  }
}

export function automationOps(engine: Engine): readonly Op[] {
  return [
    defineOp({
      name: "automation.create",
      args: CreateArgs,
      actors: ACTORS,
      run: (api, args) =>
        guarded(async () =>
          shown(api, await engine.create(args, callerOf(api), Date.now(), `auto-${stableId(api.commandId)}`)),
        ),
    }),
    defineOp({
      name: "automation.list",
      read: true,
      args: obj({}),
      actors: ACTORS,
      run: (api) =>
        guarded(async () => ({ automations: (await engine.list(callerOf(api))).map((view) => shown(api, view)) })),
    }),
    defineOp({
      name: "automation.get",
      read: true,
      args: GetArgs,
      actors: ACTORS,
      run: (api, args) => guarded(async () => shown(api, await engine.get(args.id, args.runs ?? 20, callerOf(api)))),
    }),
    defineOp({
      name: "automation.update",
      args: UpdateArgs,
      actors: ACTORS,
      run: (api, args) => guarded(async () => shown(api, await engine.update(args, callerOf(api), Date.now()))),
    }),
    defineOp({
      name: "automation.delete",
      args: IdArgs,
      actors: ACTORS,
      run: (api, args) => guarded(async () => ({ id: args.id, deleted: await engine.remove(args.id, callerOf(api)) })),
    }),
    defineOp({
      name: "automation.trigger",
      args: TriggerArgs,
      actors: ACTORS,
      run: (api, args) =>
        guarded(() =>
          engine.trigger(args.id, args.input, Date.now(), `manual:${stableId(api.commandId)}`, callerOf(api)),
        ),
    }),
    defineOp({
      name: "automation.runs",
      args: RunsArgs,
      actors: ACTORS,
      run: async (api, args) => ({
        runs: [...(await guarded(() => engine.runs(args.id, args.limit ?? 20, args.before, callerOf(api))))],
      }),
    }),
  ]
}
