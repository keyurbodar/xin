import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import {
  type ConversationId,
  defineExtension,
  defineTask,
  type Extension,
  type Harness,
  UsageDoc,
} from "@earendil-works/pi-durable"
import type { IntakeService } from "../../src/contracts/intake.ts"
import type { PushService } from "../../src/contracts/push.ts"
import { projectByRef, scopeOf } from "../../src/contracts/scope.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import type { ThreadSettled } from "../../src/contracts/threads.ts"
import type { CommandId } from "../../src/ids.ts"
import type { Actor, Command, Outcome } from "../../src/ops.ts"
import { serial } from "../../src/serial.ts"
import { CronError, nextCron, parseCron, validZone } from "./cron.ts"
import {
  type AutomationRow,
  type BatchRow,
  type NewTrigger,
  type RunRow,
  type RunSource,
  Store,
  type Target,
  type TriggerRow,
} from "./store.ts"

const context = BACKGROUND_CONTEXT

export const MAX_TITLE = 120
export const MAX_PROMPT = 8_000
export const MAX_TRIGGERS = 20
export const MAX_RULES = 10
export const MAX_BODY = 64 * 1024
const INPUT_CLIP = 16 * 1024
const BATCH_TEXT = 32 * 1024
const BATCH_INPUTS = 50
const DEFAULT_MAX_WAIT_S = 24 * 3600
const HOOK_PATH = "/hooks/"
const SECRET = /^[A-Za-z0-9_-]{43}$/
const OWNER: Actor = { kind: "owner" }
/** A run imported from the old schedules keeps their delivery key, so a delivery already in intake is not repeated. */
export const LEGACY_RUN = "sched:"

export type ScheduleInput = { readonly kind: "schedule"; readonly cron: string; readonly tz?: string | undefined }
export type OnceInput = { readonly kind: "once"; readonly at: string }
export type RuleInput = {
  readonly when?: Readonly<Record<string, string>> | undefined
  readonly groupBy?: readonly string[] | undefined
  readonly count?: number | undefined
  readonly maxWaitSeconds?: number | undefined
  readonly quietSeconds?: number | undefined
}
export type WebhookInput = {
  readonly kind: "webhook"
  readonly id?: string | undefined
  readonly contains?: readonly string[] | undefined
  readonly regex?: string | undefined
  readonly rules?: readonly RuleInput[] | undefined
}
export type TriggerInput = ScheduleInput | OnceInput | WebhookInput

export type TargetInput = { readonly kind: "fresh" } | { readonly kind: "same"; readonly threadId?: number | undefined }

export type CreateInput = {
  readonly title: string
  readonly prompt: string
  readonly project?: string | undefined
  readonly target?: TargetInput | undefined
  readonly triggers: readonly TriggerInput[]
  readonly enabled?: boolean | undefined
}

export type UpdateInput = {
  readonly id: string
  readonly title?: string | undefined
  readonly prompt?: string | undefined
  readonly project?: string | undefined
  readonly target?: TargetInput | undefined
  readonly triggers?: readonly TriggerInput[] | undefined
  readonly enabled?: boolean | undefined
}

type ScheduleConfig = { readonly cron: string; readonly tz: string }
type OnceConfig = { readonly at: number }
type Rule = {
  readonly when: Readonly<Record<string, string>>
  readonly groupBy: string[]
  readonly count: number | null
  readonly maxWaitSeconds: number | null
  readonly quietSeconds: number | null
}
type WebhookConfig = {
  readonly contains: string[]
  readonly regex: string | null
  readonly rules: Rule[]
}

export type TriggerView =
  | {
      readonly id: string
      readonly kind: "schedule"
      readonly cron: string
      readonly tz: string
      readonly nextAt: string | null
    }
  | { readonly id: string; readonly kind: "once"; readonly at: string; readonly nextAt: string | null }
  | {
      readonly id: string
      readonly kind: "webhook"
      readonly path: string
      readonly contains: string[]
      readonly regex: string | null
      readonly rules: Rule[]
    }

export type RunView = {
  readonly id: string
  readonly automationId: string
  readonly triggerId: string | null
  readonly source: RunSource
  readonly status: RunRow["status"]
  readonly threadId: number | null
  readonly inputs: number
  readonly input: string | null
  readonly error: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly cost: number | null
  readonly tokens: number | null
}

export type AutomationView = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly project: string | null
  readonly target: Target
  readonly threadId: number | null
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly nextAt: string | null
  readonly triggers: TriggerView[]
  readonly lastRun: RunView | null
}

export type BatchView = {
  readonly triggerId: string
  readonly rule: number
  readonly group: string
  readonly count: number
  readonly firstAt: string
  readonly closeAt: string
}

export type AutomationDetail = AutomationView & {
  readonly runs: RunView[]
  readonly batches: BatchView[]
}

export type AutomationErrorCode = "invalid" | "not_found" | "subagent_session"

export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type EnginePort = {
  readonly db: SqliteDatabase
  readonly harness: Harness
  readonly run: (command: Command, actor: Actor) => Promise<Outcome>
  readonly intake: Pick<IntakeService, "enqueue">
  readonly notify: Pick<PushService, "notify" | "prefs">
  readonly arm: () => Promise<void>
  readonly changed: () => Promise<void>
}

/** Who asked: the owner, or the conversation an agent runs in, which supplies the default project and thread. */
export type Caller = { readonly conversationId?: ConversationId | undefined }

type Deadline = { readonly at: number | undefined }

const commandId = (value: string): CommandId => value as CommandId
const iso = (ms: number): string => new Date(ms).toISOString()
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms))

export class Engine {
  readonly store: Store
  readonly #queue = serial()
  #deadline: Deadline | undefined
  #revision = 0
  #threads: Promise<Map<number, Set<string>>> | undefined

  constructor(private readonly port: EnginePort) {
    this.store = new Store(port.db)
  }

  get revision(): number {
    return this.#revision
  }

  /** The automations whose runs went to a conversation, from memory after the first call. */
  async automationsOf(conversationId: number): Promise<readonly string[]> {
    return [...((await this.#runThreads()).get(conversationId) ?? [])]
  }

  #runThreads(): Promise<Map<number, Set<string>>> {
    this.#threads ??= this.store.runThreads().then((rows) => {
      const threads = new Map<number, Set<string>>()
      for (const row of rows)
        threads.set(row.thread_id, (threads.get(row.thread_id) ?? new Set()).add(row.automation_id))
      return threads
    })
    return this.#threads
  }

  async #ranOn(threadId: number, automationId: string): Promise<void> {
    const threads = await this.#runThreads()
    threads.set(threadId, (threads.get(threadId) ?? new Set()).add(automationId))
  }

  async create(input: CreateInput, caller: Caller, now: number, id: string): Promise<AutomationView> {
    const view = await this.#queue(async () => {
      const scoped = await this.#scope(caller)
      const existing = await this.store.automation(id)
      if (existing !== undefined && visible(existing, scoped)) return this.#view(existing)
      if (existing !== undefined) throw invalid(`the id ${id} is taken`)
      const target = await this.#target(input.target, caller)
      const project = await this.#project(input.project, caller, target)
      await this.#within(scoped, project, target.threadId, caller)
      const row: AutomationRow = {
        id,
        title: titleOf(input.title),
        prompt: promptOf(input.prompt),
        project,
        target: target.kind,
        thread_id: target.threadId,
        enabled: input.enabled === false ? 0 : 1,
        created_at: now,
        updated_at: now,
      }
      await this.store.save(row, await this.#triggers(id, input.triggers, row.enabled === 1, now))
      return this.#view(row)
    })
    await this.#changed()
    return view
  }

  async update(input: UpdateInput, caller: Caller, now: number): Promise<AutomationView> {
    const view = await this.#queue(async () => {
      const { row: current, scoped } = await this.#owned(input.id, caller)
      const target =
        input.target === undefined
          ? { kind: current.target, threadId: current.thread_id }
          : await this.#target(input.target, caller)
      const project = input.project === undefined ? current.project : await this.#project(input.project, caller, target)
      if (target.kind === "fresh" && project === null) throw invalid("a fresh-thread automation needs a project")
      await this.#within(scoped, project, target.threadId, caller)
      const row: AutomationRow = {
        ...current,
        title: input.title === undefined ? current.title : titleOf(input.title),
        prompt: input.prompt === undefined ? current.prompt : promptOf(input.prompt),
        project,
        target: target.kind,
        thread_id: target.threadId,
        enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
        updated_at: Math.max(now, current.updated_at + 1),
      }
      const enabledChanged = row.enabled !== current.enabled
      const triggers =
        input.triggers !== undefined
          ? await this.#triggers(row.id, input.triggers, row.enabled === 1, now)
          : enabledChanged
            ? (await this.store.triggers(row.id)).map((trigger) => rearmed(trigger, row.enabled === 1, now))
            : undefined
      await this.store.save(row, triggers)
      return this.#view(row)
    })
    await this.#changed()
    return view
  }

  async remove(id: string, caller: Caller): Promise<boolean> {
    const removed = await this.#queue(async () => {
      const row = await this.store.automation(id)
      if (row === undefined || !visible(row, await this.#scope(caller))) return false
      if (!(await this.store.remove(id))) return false
      for (const ids of (await this.#runThreads()).values()) ids.delete(id)
      return true
    })
    if (removed) await this.#changed()
    return removed
  }

  async list(caller: Caller): Promise<AutomationView[]> {
    const scoped = await this.#scope(caller)
    const [automations, triggers, latest] = await Promise.all([
      this.store.automations(),
      this.store.triggers(),
      this.store.latestRuns(),
    ])
    const lastRuns = new Map(latest.map((run) => [run.automation_id, runView(run)]))
    return automations
      .filter((row) => visible(row, scoped))
      .map((row) =>
        viewOf(
          row,
          triggers.filter((trigger) => trigger.automation_id === row.id),
          lastRuns.get(row.id) ?? null,
        ),
      )
  }

  async get(id: string, runLimit: number, caller: Caller): Promise<AutomationDetail> {
    const { row } = await this.#owned(id, caller)
    const [triggers, runs, batches] = await Promise.all([
      this.store.triggers(id),
      this.store.runs(id, runLimit),
      this.store.batches(id),
    ])
    const views = runs.map(runView)
    return {
      ...viewOf(row, triggers, views[0] ?? null),
      runs: views,
      batches: batches.map((batch) => ({
        triggerId: batch.trigger_id,
        rule: batch.rule,
        group: batch.group_key,
        count: batch.count,
        firstAt: iso(batch.first_at),
        closeAt: iso(batch.close_at),
      })),
    }
  }

  async runs(id: string, limit: number, before: string | undefined, caller: Caller): Promise<RunView[]> {
    await this.#owned(id, caller)
    const cursor = before === undefined ? undefined : Date.parse(before)
    if (cursor !== undefined && Number.isNaN(cursor)) throw invalid("before must be an ISO time")
    return (await this.store.runs(id, limit, cursor)).map(runView)
  }

  /** A manual run: it starts even while the automation is disabled. */
  async trigger(id: string, input: string | undefined, now: number, runId: string, caller: Caller): Promise<RunView> {
    await this.#owned(id, caller)
    await this.store.addRun({
      id: runId,
      automation_id: id,
      trigger_id: null,
      source: "manual",
      input: input === undefined ? null : clip(input),
      inputs: input === undefined ? 0 : 1,
      created_at: now,
    })
    await this.port.arm()
    await this.#dispatch(runId, now)
    await this.#changed()
    const run = await this.store.run(runId)
    if (run === undefined) throw new AutomationError("not_found", `the run of ${id} was deleted`)
    return runView(run)
  }

  /** The clock's deadline: the earliest trigger or batch, now while a run waits to start, and nothing when idle. */
  async due(): Promise<number | undefined> {
    if (this.#deadline === undefined) {
      const found = await this.store.deadline()
      const times = [found.next, found.close].filter((at): at is number => at !== null)
      if (found.queued) times.push(Date.now())
      this.#deadline = { at: times.length === 0 ? undefined : Math.min(...times) }
    }
    return this.#deadline.at
  }

  async fire(now: number): Promise<void> {
    const at = await this.due()
    if (at === undefined || at > now) return
    const started = await this.#queue(async () => {
      const ids: string[] = []
      for (const trigger of await this.store.dueTriggers(now)) {
        const id = await this.#fireTrigger(trigger, now)
        if (id !== undefined) ids.push(id)
      }
      for (const batch of await this.store.dueBatches(now)) ids.push(await this.#closeBatch(batch, now))
      for (const run of await this.store.queuedRuns()) if (!ids.includes(run.id)) ids.push(run.id)
      this.#deadline = undefined
      return ids
    })
    for (const id of started) await this.#dispatch(id, now)
    if (started.length > 0) await this.#changed()
  }

  async webhook(request: Request, now: number): Promise<Response> {
    const secret = new URL(request.url).pathname.slice(HOOK_PATH.length)
    if (!SECRET.test(secret)) return new Response("not found", { status: 404 })
    const trigger = await this.store.bySecret(secret)
    if (trigger === undefined || trigger.kind !== "webhook") return new Response("not found", { status: 404 })
    const body = await boundedText(request, MAX_BODY)
    if (body === undefined) return new Response("payload too large", { status: 413 })
    const delivery = request.headers.get("idempotency-key") ?? request.headers.get("x-github-delivery") ?? undefined
    const outcome = await this.#queue(async () => {
      const automation = await this.store.automation(trigger.automation_id)
      if (automation === undefined) return undefined
      if (automation.enabled === 0) return { status: "ignored", reason: "disabled" } as const
      const config = webhookConfig(trigger)
      if (!conditionsMatch(config, body)) return { status: "ignored", reason: "conditions" } as const
      return this.#deliver(trigger, config, body, delivery, now)
    })
    if (outcome === undefined) return new Response("not found", { status: 404 })
    if (outcome.status === "ignored") return Response.json(outcome)
    await this.port.arm()
    const started = [outcome.closed, outcome.status === "started" ? outcome.run : undefined].filter(
      (run): run is string => run !== undefined,
    )
    for (const run of started) await this.#dispatch(run, now)
    if (started.length > 0) await this.#changed()
    return Response.json(outcome, { status: 202 })
  }

  async settled(event: ThreadSettled, now: number): Promise<void> {
    const running = await this.store.runningOn(event.threadId)
    if (running.length === 0) return
    const usage = await usageOf(this.port.harness, event.threadId)
    for (const run of running) {
      const spent =
        usage === undefined
          ? undefined
          : { cost: usage.cost - (run.base_cost ?? 0), tokens: usage.tokens - (run.base_tokens ?? 0) }
      await this.store.finished(
        run.id,
        event.status,
        now,
        spent,
        event.status === "failed" ? clipTo(event.result ?? "the thread failed", 500) : null,
      )
    }
    await this.#changed()
  }

  async #fireTrigger(trigger: TriggerRow, now: number): Promise<string | undefined> {
    const automation = await this.store.automation(trigger.automation_id)
    const slot = trigger.next_at ?? now
    const next = trigger.kind === "schedule" && automation?.enabled === 1 ? scheduleNext(trigger, now) : null
    await this.store.setNext(trigger.id, next)
    if (automation === undefined || automation.enabled === 0) return undefined
    const id = `${trigger.kind}:${trigger.id}:${slot}`
    const added = await this.store.addRun({
      id,
      automation_id: automation.id,
      trigger_id: trigger.id,
      source: "schedule",
      input: null,
      inputs: 0,
      created_at: now,
    })
    return added ? id : undefined
  }

  async #closeBatch(batch: BatchRow, now: number): Promise<string> {
    const inputs = parseInputs(batch.inputs)
    const id = `batch:${batch.trigger_id}:${batch.rule}:${await digest(batch.group_key)}:${batch.first_at}`
    await this.store.addRun({
      id,
      automation_id: batch.automation_id,
      trigger_id: batch.trigger_id,
      source: "webhook",
      input: webhookText(inputs),
      inputs: batch.count,
      created_at: now,
    })
    await this.store.dropBatch(batch)
    return id
  }

  async #deliver(
    trigger: TriggerRow,
    config: WebhookConfig,
    body: string,
    delivery: string | undefined,
    now: number,
  ): Promise<
    | { readonly status: "started"; readonly run: string; readonly closed?: string }
    | { readonly status: "batched"; readonly count: number; readonly closed?: string }
  > {
    const payload = parseJson(body)
    const index = config.rules.findIndex((rule) => whenMatches(rule, payload))
    const rule = config.rules[index]
    if (rule === undefined) {
      const run = `webhook:${trigger.id}:${delivery === undefined ? crypto.randomUUID() : clipTo(delivery, 128)}`
      await this.store.addRun({
        id: run,
        automation_id: trigger.automation_id,
        trigger_id: trigger.id,
        source: "webhook",
        input: webhookText([body]),
        inputs: 1,
        created_at: now,
      })
      return { status: "started", run }
    }
    const group = JSON.stringify(rule.groupBy.map((path) => fieldOf(payload, path) ?? null))
    const open = await this.store.batch(trigger.id, index, group)
    const id = delivery === undefined ? undefined : clipTo(delivery, 128)
    if (open !== undefined && id !== undefined && parseInputs(open.deliveries).includes(id))
      return { status: "batched", count: open.count }
    const input = clip(body)
    const overflows = open !== undefined && textSize(parseInputs(open.inputs)) + input.length > BATCH_TEXT
    const closed = open !== undefined && overflows ? { closed: await this.#closeBatch(open, now) } : {}
    const kept = overflows ? undefined : open
    const first = kept?.first_at ?? now
    const batch: BatchRow = {
      trigger_id: trigger.id,
      rule: index,
      group_key: group,
      automation_id: trigger.automation_id,
      count: (kept?.count ?? 0) + 1,
      inputs: JSON.stringify([...(kept === undefined ? [] : parseInputs(kept.inputs)), input]),
      deliveries: JSON.stringify([
        ...(kept === undefined ? [] : parseInputs(kept.deliveries)),
        ...(id === undefined ? [] : [id]),
      ]),
      first_at: first,
      last_at: now,
      close_at: closeAt(rule, first, now),
    }
    if ((rule.count !== null && batch.count >= rule.count) || batch.count >= BATCH_INPUTS)
      return { status: "started", run: await this.#closeBatch(batch, now), ...closed }
    await this.store.putBatch(batch)
    this.#deadline = undefined
    return { status: "batched", count: batch.count, ...closed }
  }

  async #dispatch(id: string, now: number): Promise<void> {
    const run = await this.store.run(id)
    if (run === undefined || run.status !== "queued") return
    try {
      const automation = await this.store.automation(run.automation_id)
      if (automation === undefined) return await this.store.failed(id, "the automation was deleted", now)
      const text = taskText(automation.prompt, run.input)
      const command = commandId(run.id.startsWith(LEGACY_RUN) ? run.id : `automation:${run.id}`)
      if (automation.target === "same" && automation.thread_id !== null) {
        const delivered = await this.#continue(automation, automation.thread_id, run, text, command, now)
        if (delivered) return await this.#notify(automation, run)
      }
      if (automation.project === null) return await this.store.failed(id, "no project to start a thread in", now)
      const outcome = await this.port.run(
        {
          id: command,
          op: "thread.create",
          args: { title: automation.title, task: text, project: automation.project },
        },
        OWNER,
      )
      if (outcome.kind === "rejected") return await this.store.failed(id, outcome.message, now)
      const threadId = numberField(outcome.result, "threadId")
      if (threadId === undefined) return await this.store.failed(id, "thread.create returned no thread", now)
      if (automation.target === "same") await this.store.setThread(automation.id, threadId)
      await this.store.started(id, "running", threadId, now, { cost: 0, tokens: 0 })
      await this.#ranOn(threadId, automation.id)
      await this.#notify(automation, run)
    } catch (error) {
      console.warn("automations: a run failed to start", error)
      await this.store.failed(id, error instanceof Error ? clipTo(error.message, 500) : "the run failed to start", now)
    }
  }

  /** Delivers into the automation's standing conversation; false when it no longer exists. */
  async #continue(
    automation: AutomationRow,
    threadId: number,
    run: RunRow,
    text: string,
    command: CommandId,
    now: number,
  ): Promise<boolean> {
    const conversationId = threadId as ConversationId
    if ((await this.port.harness.conversation(conversationId, context)) === undefined) return false
    const base = await usageOf(this.port.harness, threadId)
    if ((await this.port.harness.snapshot(ThreadDoc, conversationId, context)) !== undefined) {
      const outcome = await this.port.run(
        { id: command, op: "thread.send", args: { threadId, text, mode: "queue" } },
        OWNER,
      )
      if (outcome.kind === "rejected") await this.store.failed(run.id, outcome.message, now)
      else {
        await this.store.started(run.id, "running", threadId, now, base)
        await this.#ranOn(threadId, automation.id)
      }
      return true
    }
    await this.port.intake.enqueue({
      target: conversationId,
      commandId: command,
      kind: "job",
      threadId: automation.id,
      title: automation.title,
      status: "automation",
      text,
      clientTs: now,
    })
    await this.port.arm()
    await this.store.started(run.id, "delivered", threadId, now, base)
    await this.#ranOn(threadId, automation.id)
    return true
  }

  /** The run already started, so its push is best effort. */
  async #notify(automation: AutomationRow, run: RunRow): Promise<void> {
    try {
      if (!(await this.port.notify.prefs()).schedule) return
      await this.port.notify.notify({
        threadTitle: automation.title,
        title: "An automation ran",
        body: clipTo(automation.prompt, 120),
        tag: `automation:${run.id}`,
        kind: "schedule",
      })
    } catch (failure) {
      console.warn("automations: notification failed", failure)
    }
  }

  async #changed(): Promise<void> {
    this.#deadline = undefined
    this.#revision += 1
    await this.port.arm()
    await this.port.changed()
  }

  /** The project an agent caller is confined to; undefined for the owner and the root chat. Delegated threads are refused. */
  async #scope(caller: Caller): Promise<string | undefined> {
    const id = caller.conversationId
    if (id === undefined) return undefined
    if ((await this.port.harness.snapshot(ThreadDoc, id, context)) !== undefined)
      throw new AutomationError(
        "subagent_session",
        "a delegated thread cannot manage automations; ask the project's coordinator",
      )
    const scope = await scopeOf(this.port.harness, id)
    return scope === undefined || scope.kind === "puck" ? undefined : scope.projectId
  }

  async #owned(
    id: string,
    caller: Caller,
  ): Promise<{ readonly row: AutomationRow; readonly scoped: string | undefined }> {
    const scoped = await this.#scope(caller)
    const row = await this.#found(id)
    if (!visible(row, scoped)) throw new AutomationError("not_found", `no automation ${id}`)
    return { row, scoped }
  }

  async #within(
    scoped: string | undefined,
    project: string | null,
    threadId: number | null,
    caller: Caller,
  ): Promise<void> {
    if (scoped === undefined) return
    if (project !== scoped) throw invalid("an automation can only use this conversation's own project")
    if (threadId === null || threadId === caller.conversationId) return
    const scope = await scopeOf(this.port.harness, threadId as ConversationId)
    if (scope === undefined || scope.kind === "puck" || scope.projectId !== scoped)
      throw invalid(`conversation ${threadId} is outside this project`)
  }

  async #found(id: string): Promise<AutomationRow> {
    const row = await this.store.automation(id)
    if (row === undefined) throw new AutomationError("not_found", `no automation ${id}`)
    return row
  }

  async #view(row: AutomationRow): Promise<AutomationView> {
    const [triggers, latest] = await Promise.all([this.store.triggers(row.id), this.store.runs(row.id, 1)])
    return viewOf(row, triggers, latest[0] === undefined ? null : runView(latest[0]))
  }

  async #target(
    input: TargetInput | undefined,
    caller: Caller,
  ): Promise<{ readonly kind: Target; readonly threadId: number | null }> {
    if (input === undefined || input.kind === "fresh") return { kind: "fresh", threadId: null }
    const threadId = input.threadId ?? caller.conversationId ?? null
    if (threadId !== null && (await this.port.harness.conversation(threadId as ConversationId, context)) === undefined)
      throw invalid(`no conversation ${threadId}`)
    return { kind: "same", threadId }
  }

  async #project(
    ref: string | undefined,
    caller: Caller,
    target: { readonly kind: Target; readonly threadId: number | null },
  ): Promise<string | null> {
    if (ref !== undefined) {
      const found = await projectByRef(this.port.harness, ref)
      if (found === undefined) throw invalid(`no project "${ref}"`)
      return found.projectId
    }
    if (caller.conversationId !== undefined) {
      const scope = await scopeOf(this.port.harness, caller.conversationId)
      if (scope !== undefined && scope.kind !== "puck") return scope.projectId
    }
    if (target.kind === "same" && target.threadId !== null) return null
    throw invalid("give a project for the automation's threads")
  }

  async #triggers(
    automationId: string,
    inputs: readonly TriggerInput[],
    enabled: boolean,
    now: number,
  ): Promise<readonly NewTrigger[]> {
    if (inputs.length > MAX_TRIGGERS) throw invalid(`at most ${MAX_TRIGGERS} triggers`)
    const existing = new Map((await this.store.triggers(automationId)).map((row) => [row.id, row]))
    return inputs.map((input) => {
      switch (input.kind) {
        case "schedule": {
          const tz = input.tz ?? "UTC"
          if (!validZone(tz)) throw invalid(`unknown time zone "${tz}"`)
          const config: ScheduleConfig = { cron: input.cron.trim(), tz }
          const cron = guarded(() => parseCron(config.cron))
          const next = nextCron(cron, tz, now)
          if (next === undefined) throw invalid(`"${input.cron}" never fires`)
          return {
            id: crypto.randomUUID(),
            kind: "schedule",
            config: JSON.stringify(config),
            secret: null,
            next_at: enabled ? next : null,
          }
        }
        case "once": {
          const at = Date.parse(input.at)
          if (Number.isNaN(at)) throw invalid(`"${input.at}" is not an ISO time`)
          if (at <= now) throw invalid("a one-time trigger must be in the future")
          const config: OnceConfig = { at }
          return {
            id: crypto.randomUUID(),
            kind: "once",
            config: JSON.stringify(config),
            secret: null,
            next_at: enabled ? at : null,
          }
        }
        case "webhook": {
          const kept = input.id === undefined ? undefined : existing.get(input.id)
          if (input.id !== undefined && kept?.kind !== "webhook")
            throw invalid(`no webhook trigger ${input.id} on this automation`)
          const config = webhookInput(input)
          return {
            id: kept?.id ?? crypto.randomUUID(),
            kind: "webhook",
            config: JSON.stringify(config),
            secret: kept?.secret ?? mintSecret(),
            next_at: null,
          }
        }
        default: {
          const _exhaustive: never = input
          return _exhaustive
        }
      }
    })
  }
}

/**
 * Schedules that `xin.schedules` (the plugin Automations replaced) left as pi tasks end at their next wake instead of
 * sitting blocked on a missing task definition.
 */
export function retiredSchedules(): Extension {
  return defineExtension({
    name: "automations-retired-schedules",
    tasks: [
      defineTask<JsonValue, { readonly phase: "retired" }, null, object>({
        name: "xin.schedule",
        version: 3,
        initial: () => ({ phase: "retired" }),
        migrate: (input) => ({ input, checkpoint: { phase: "retired" } }),
        phases: {
          retired: (_task, runtime, ctx) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
        },
        abort: (_task, runtime, ctx) =>
          runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
      }),
    ],
  })
}

function rearmed(trigger: TriggerRow, enabled: boolean, now: number): NewTrigger {
  const base = { id: trigger.id, kind: trigger.kind, config: trigger.config, secret: trigger.secret }
  if (!enabled || trigger.kind === "webhook") return { ...base, next_at: null }
  if (trigger.kind === "schedule") return { ...base, next_at: scheduleNext(trigger, now) }
  const at = onceConfig(trigger).at
  return { ...base, next_at: at > now ? at : null }
}

function scheduleNext(trigger: TriggerRow, now: number): number | null {
  const config = scheduleConfig(trigger)
  return nextCron(parseCron(config.cron), config.tz, now) ?? null
}

const visible = (row: AutomationRow, scoped: string | undefined): boolean =>
  scoped === undefined || row.project === scoped

/** A view for the model: a webhook's secret is its only credential, so only the owner's surfaces show it. */
export function withoutSecrets<T extends AutomationView>(view: T): T {
  return {
    ...view,
    triggers: view.triggers.map((trigger) =>
      trigger.kind === "webhook" ? { ...trigger, path: `${HOOK_PATH}<shown to the owner only>` } : trigger,
    ),
  }
}

function viewOf(row: AutomationRow, triggers: readonly TriggerRow[], lastRun: RunView | null): AutomationView {
  const next = triggers.flatMap((trigger) => (trigger.next_at === null ? [] : [trigger.next_at]))
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    project: row.project,
    target: row.target,
    threadId: row.thread_id,
    enabled: row.enabled === 1,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    nextAt: next.length === 0 ? null : iso(Math.min(...next)),
    triggers: triggers.map(triggerView),
    lastRun,
  }
}

function triggerView(trigger: TriggerRow): TriggerView {
  switch (trigger.kind) {
    case "schedule": {
      const config = scheduleConfig(trigger)
      return { id: trigger.id, kind: "schedule", cron: config.cron, tz: config.tz, nextAt: isoOrNull(trigger.next_at) }
    }
    case "once":
      return { id: trigger.id, kind: "once", at: iso(onceConfig(trigger).at), nextAt: isoOrNull(trigger.next_at) }
    case "webhook": {
      const config = webhookConfig(trigger)
      return {
        id: trigger.id,
        kind: "webhook",
        path: `${HOOK_PATH}${trigger.secret ?? ""}`,
        contains: config.contains,
        regex: config.regex,
        rules: config.rules,
      }
    }
    default: {
      const _exhaustive: never = trigger.kind
      return _exhaustive
    }
  }
}

function runView(run: RunRow): RunView {
  return {
    id: run.id,
    automationId: run.automation_id,
    triggerId: run.trigger_id,
    source: run.source,
    status: run.status,
    threadId: run.thread_id,
    inputs: run.inputs,
    input: run.input,
    error: run.error,
    createdAt: iso(run.created_at),
    startedAt: isoOrNull(run.started_at),
    finishedAt: isoOrNull(run.finished_at),
    cost: run.cost,
    tokens: run.tokens,
  }
}

const scheduleConfig = (trigger: TriggerRow): ScheduleConfig => JSON.parse(trigger.config) as ScheduleConfig
const onceConfig = (trigger: TriggerRow): OnceConfig => JSON.parse(trigger.config) as OnceConfig
const webhookConfig = (trigger: TriggerRow): WebhookConfig => JSON.parse(trigger.config) as WebhookConfig

function webhookInput(input: WebhookInput): WebhookConfig {
  const rules = input.rules ?? []
  if (rules.length > MAX_RULES) throw invalid(`at most ${MAX_RULES} coalescing rules`)
  if (input.regex !== undefined && !validRegex(input.regex))
    throw invalid(`"${input.regex}" is not a valid regular expression`)
  return {
    contains: [...(input.contains ?? [])],
    regex: input.regex ?? null,
    rules: rules.map((rule) => ({
      when: rule.when ?? {},
      groupBy: [...(rule.groupBy ?? [])],
      count: rule.count ?? null,
      maxWaitSeconds: rule.maxWaitSeconds ?? null,
      quietSeconds: rule.quietSeconds ?? null,
    })),
  }
}

function validRegex(source: string): boolean {
  try {
    return new RegExp(source).source.length > 0
  } catch {
    return false
  }
}

function conditionsMatch(config: WebhookConfig, body: string): boolean {
  if (config.contains.length > 0 && !config.contains.some((text) => body.includes(text))) return false
  return config.regex === null || new RegExp(config.regex).test(body)
}

function whenMatches(rule: Rule, payload: unknown): boolean {
  return Object.entries(rule.when).every(([path, expected]) => {
    const found = fieldOf(payload, path)
    return found !== undefined && found !== null && String(found) === expected
  })
}

function closeAt(rule: Rule, first: number, last: number): number {
  const closers: number[] = []
  if (rule.maxWaitSeconds !== null) closers.push(first + rule.maxWaitSeconds * 1000)
  if (rule.quietSeconds !== null) closers.push(last + rule.quietSeconds * 1000)
  if (closers.length === 0) closers.push(first + DEFAULT_MAX_WAIT_S * 1000)
  return Math.min(...closers)
}

function fieldOf(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return typeof current === "object" && current !== null ? JSON.stringify(current) : current
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function parseInputs(stored: string): string[] {
  const parsed: unknown = JSON.parse(stored)
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
}

const textSize = (inputs: readonly string[]): number => inputs.reduce((sum, input) => sum + input.length, 0)

async function boundedText(request: Request, max: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > max) return undefined
  if (request.body === null) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function webhookText(inputs: readonly string[]): string {
  if (inputs.length === 1) return `<webhook>\n${clip(inputs[0] ?? "")}\n</webhook>`
  return inputs.map((input, index) => `<webhook n="${index + 1}">\n${input}\n</webhook>`).join("\n")
}

function taskText(prompt: string, input: string | null): string {
  if (input === null) return prompt
  return input.startsWith("<webhook") ? `${prompt}\n\n${input}` : `${prompt}\n\n<input>\n${input}\n</input>`
}

async function usageOf(harness: Harness, threadId: number): Promise<{ cost: number; tokens: number } | undefined> {
  const ledger = await harness.snapshot(UsageDoc, threadId as ConversationId, context)
  if (ledger === undefined) return undefined
  return [...Object.values(ledger.models), ...Object.values(ledger.tools)].reduce(
    (sum, bucket) => ({ cost: sum.cost + bucket.cost.total, tokens: sum.tokens + bucket.totalTokens }),
    { cost: 0, tokens: 0 },
  )
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === "number" ? found : undefined
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(hash).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function titleOf(value: string): string {
  const title = value.trim()
  if (title.length === 0 || title.length > MAX_TITLE) throw invalid(`title must be 1 to ${MAX_TITLE} characters`)
  return title
}

function promptOf(value: string): string {
  const prompt = value.trim()
  if (prompt.length === 0 || prompt.length > MAX_PROMPT) throw invalid(`prompt must be 1 to ${MAX_PROMPT} characters`)
  return prompt
}

function guarded<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof CronError) throw invalid(error.message)
    throw error
  }
}

function invalid(message: string): AutomationError {
  return new AutomationError("invalid", message)
}

const clip = (text: string): string => clipTo(text, INPUT_CLIP)

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
