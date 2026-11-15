import type { SqliteDatabase, SqliteExecutor, SqliteMigration } from "@earendil-works/chord/sqlite"

export const OWNER = "automations"

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE automations (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, project TEXT, target TEXT NOT NULL CHECK (target IN ('fresh','same')), thread_id INTEGER, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE automation_triggers (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('schedule','once','webhook')), config TEXT NOT NULL, secret TEXT UNIQUE, next_at INTEGER)",
      "CREATE INDEX automation_triggers_owner ON automation_triggers (automation_id)",
      "CREATE INDEX automation_triggers_next ON automation_triggers (next_at) WHERE next_at IS NOT NULL",
      "CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, trigger_id TEXT, source TEXT NOT NULL CHECK (source IN ('schedule','webhook','manual')), status TEXT NOT NULL CHECK (status IN ('queued','running','delivered','completed','failed','cancelled')), thread_id INTEGER, input TEXT, inputs INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, base_cost REAL, base_tokens INTEGER, cost REAL, tokens INTEGER)",
      "CREATE INDEX automation_runs_by ON automation_runs (automation_id, created_at)",
      "CREATE INDEX automation_runs_open ON automation_runs (status, thread_id) WHERE status IN ('queued','running')",
      "CREATE TABLE automation_batches (trigger_id TEXT NOT NULL, rule INTEGER NOT NULL, group_key TEXT NOT NULL, automation_id TEXT NOT NULL, count INTEGER NOT NULL, inputs TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, close_at INTEGER NOT NULL, PRIMARY KEY (trigger_id, rule, group_key))",
      "CREATE INDEX automation_batches_close ON automation_batches (close_at)",
    ],
  },
  {
    version: 2,
    statements: ["ALTER TABLE automation_batches ADD COLUMN deliveries TEXT NOT NULL DEFAULT '[]'"],
  },
]

export type Target = "fresh" | "same"
export type TriggerKind = "schedule" | "once" | "webhook"
export type RunSource = "schedule" | "webhook" | "manual"
export type RunStatus = "queued" | "running" | "delivered" | "completed" | "failed" | "cancelled"

export type AutomationRow = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly project: string | null
  readonly target: Target
  readonly thread_id: number | null
  readonly enabled: number
  readonly created_at: number
  readonly updated_at: number
}

export type TriggerRow = {
  readonly id: string
  readonly automation_id: string
  readonly position: number
  readonly kind: TriggerKind
  readonly config: string
  readonly secret: string | null
  readonly next_at: number | null
}

export type RunRow = {
  readonly id: string
  readonly automation_id: string
  readonly trigger_id: string | null
  readonly source: RunSource
  readonly status: RunStatus
  readonly thread_id: number | null
  readonly input: string | null
  readonly inputs: number
  readonly error: string | null
  readonly created_at: number
  readonly started_at: number | null
  readonly finished_at: number | null
  readonly base_cost: number | null
  readonly base_tokens: number | null
  readonly cost: number | null
  readonly tokens: number | null
}

export type BatchRow = {
  readonly trigger_id: string
  readonly rule: number
  readonly group_key: string
  readonly automation_id: string
  readonly count: number
  readonly inputs: string
  readonly deliveries: string
  readonly first_at: number
  readonly last_at: number
  readonly close_at: number
}

const AUTOMATION_COLUMNS = "id, title, prompt, project, target, thread_id, enabled, created_at, updated_at"
const TRIGGER_COLUMNS = "id, automation_id, position, kind, config, secret, next_at"
const RUN_COLUMNS =
  "id, automation_id, trigger_id, source, status, thread_id, input, inputs, error, created_at, started_at, finished_at, base_cost, base_tokens, cost, tokens"

/** Runs kept per automation; older ones drop out when a new run is recorded. */
export const RUNS_KEPT = 50

export type NewTrigger = Omit<TriggerRow, "automation_id" | "position">

export type NewRun = Pick<RunRow, "id" | "automation_id" | "trigger_id" | "source" | "input" | "inputs" | "created_at">

export class Store {
  constructor(private readonly db: SqliteDatabase) {}

  automation(id: string): Promise<AutomationRow | undefined> {
    return this.db.get<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE id = ?`, id)
  }

  automations(): Promise<AutomationRow[]> {
    return this.db.all<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations ORDER BY created_at, id`)
  }

  triggers(automationId?: string): Promise<TriggerRow[]> {
    return automationId === undefined
      ? this.db.all<TriggerRow>(`SELECT ${TRIGGER_COLUMNS} FROM automation_triggers ORDER BY automation_id, position`)
      : this.db.all<TriggerRow>(
          `SELECT ${TRIGGER_COLUMNS} FROM automation_triggers WHERE automation_id = ? ORDER BY position`,
          automationId,
        )
  }

  bySecret(secret: string): Promise<TriggerRow | undefined> {
    return this.db.get<TriggerRow>(`SELECT ${TRIGGER_COLUMNS} FROM automation_triggers WHERE secret = ?`, secret)
  }

  dueTriggers(now: number): Promise<TriggerRow[]> {
    return this.db.all<TriggerRow>(
      `SELECT ${TRIGGER_COLUMNS} FROM automation_triggers WHERE next_at IS NOT NULL AND next_at <= ?`,
      now,
    )
  }

  /** The earliest timed deadline and whether a run waits to be started, in one statement. */
  async deadline(): Promise<{ readonly next: number | null; readonly close: number | null; readonly queued: number }> {
    const row = await this.db.get<{ next: number | null; close: number | null; queued: number }>(
      `SELECT (SELECT MIN(next_at) FROM automation_triggers WHERE next_at IS NOT NULL) AS next,
              (SELECT MIN(close_at) FROM automation_batches) AS close,
              EXISTS (SELECT 1 FROM automation_runs WHERE status = 'queued') AS queued`,
    )
    return row ?? { next: null, close: null, queued: 0 }
  }

  save(automation: AutomationRow, triggers: readonly NewTrigger[] | undefined): Promise<void> {
    return this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO automations (${AUTOMATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, prompt = excluded.prompt, project = excluded.project,
           target = excluded.target, thread_id = excluded.thread_id, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        automation.id,
        automation.title,
        automation.prompt,
        automation.project,
        automation.target,
        automation.thread_id,
        automation.enabled,
        automation.created_at,
        automation.updated_at,
      )
      if (triggers === undefined) return
      await replaceTriggers(tx, automation.id, triggers)
    })
  }

  setNext(triggerId: string, next: number | null): Promise<void> {
    return this.db.run("UPDATE automation_triggers SET next_at = ? WHERE id = ?", next, triggerId)
  }

  /** Every conversation a run of an automation went to, for the Drive scope those conversations see. */
  runThreads(): Promise<{ readonly automation_id: string; readonly thread_id: number }[]> {
    return this.db.all(
      "SELECT automation_id, thread_id FROM automation_runs WHERE thread_id IS NOT NULL UNION SELECT id, thread_id FROM automations WHERE thread_id IS NOT NULL",
    )
  }

  setThread(automationId: string, threadId: number): Promise<void> {
    return this.db.run("UPDATE automations SET thread_id = ? WHERE id = ?", threadId, automationId)
  }

  remove(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const removed = await tx.runCounted("DELETE FROM automations WHERE id = ?", id)
      await tx.run("DELETE FROM automation_triggers WHERE automation_id = ?", id)
      await tx.run("DELETE FROM automation_batches WHERE automation_id = ?", id)
      await tx.run("DELETE FROM automation_runs WHERE automation_id = ?", id)
      return removed > 0
    })
  }

  /** Records a run once: a replayed delivery or a repeated fire with the same id changes nothing. */
  async addRun(run: NewRun): Promise<boolean> {
    const added = await this.db.runCounted(
      `INSERT OR IGNORE INTO automation_runs (id, automation_id, trigger_id, source, status, input, inputs, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      run.id,
      run.automation_id,
      run.trigger_id,
      run.source,
      run.input,
      run.inputs,
      run.created_at,
    )
    if (added === 0) return false
    await this.db.run(
      `DELETE FROM automation_runs WHERE automation_id = ? AND created_at < (
         SELECT created_at FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?)`,
      run.automation_id,
      run.automation_id,
      RUNS_KEPT - 1,
    )
    return true
  }

  run(id: string): Promise<RunRow | undefined> {
    return this.db.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM automation_runs WHERE id = ?`, id)
  }

  runs(automationId: string, limit: number, before?: number): Promise<RunRow[]> {
    return this.db.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM automation_runs WHERE automation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
      automationId,
      before ?? Number.MAX_SAFE_INTEGER,
      limit,
    )
  }

  latestRuns(): Promise<RunRow[]> {
    return this.db.all<RunRow & { latest: number }>(
      `SELECT ${RUN_COLUMNS}, MAX(created_at) AS latest FROM automation_runs GROUP BY automation_id`,
    )
  }

  queuedRuns(): Promise<RunRow[]> {
    return this.db.all<RunRow>(`SELECT ${RUN_COLUMNS} FROM automation_runs WHERE status = 'queued'`)
  }

  runningOn(threadId: number): Promise<RunRow[]> {
    return this.db.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM automation_runs WHERE status = 'running' AND thread_id = ?`,
      threadId,
    )
  }

  started(
    id: string,
    status: "running" | "delivered",
    threadId: number,
    at: number,
    base: { cost: number; tokens: number } | undefined,
  ): Promise<void> {
    return this.db.run(
      `UPDATE automation_runs SET status = ?, thread_id = ?, started_at = ?, base_cost = ?, base_tokens = ?,
         finished_at = CASE WHEN ? = 'delivered' THEN ? ELSE NULL END
       WHERE id = ? AND status = 'queued'`,
      status,
      threadId,
      at,
      base?.cost ?? null,
      base?.tokens ?? null,
      status,
      at,
      id,
    )
  }

  failed(id: string, error: string, at: number): Promise<void> {
    return this.db.run(
      "UPDATE automation_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'queued'",
      error,
      at,
      id,
    )
  }

  finished(
    id: string,
    status: "completed" | "failed" | "cancelled",
    at: number,
    usage: { cost: number; tokens: number } | undefined,
    error: string | null,
  ): Promise<void> {
    return this.db.run(
      `UPDATE automation_runs SET status = ?, finished_at = ?, cost = ?, tokens = ?, error = ?
       WHERE id = ? AND status = 'running'`,
      status,
      at,
      usage?.cost ?? null,
      usage?.tokens ?? null,
      error,
      id,
    )
  }

  batch(triggerId: string, rule: number, group: string): Promise<BatchRow | undefined> {
    return this.db.get<BatchRow>(
      "SELECT * FROM automation_batches WHERE trigger_id = ? AND rule = ? AND group_key = ?",
      triggerId,
      rule,
      group,
    )
  }

  batches(automationId: string): Promise<BatchRow[]> {
    return this.db.all<BatchRow>(
      "SELECT * FROM automation_batches WHERE automation_id = ? ORDER BY first_at",
      automationId,
    )
  }

  dueBatches(now: number): Promise<BatchRow[]> {
    return this.db.all<BatchRow>("SELECT * FROM automation_batches WHERE close_at <= ?", now)
  }

  putBatch(batch: BatchRow): Promise<void> {
    return this.db.run(
      `INSERT INTO automation_batches (trigger_id, rule, group_key, automation_id, count, inputs, deliveries, first_at, last_at, close_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (trigger_id, rule, group_key) DO UPDATE SET count = excluded.count, inputs = excluded.inputs,
         deliveries = excluded.deliveries, last_at = excluded.last_at, close_at = excluded.close_at`,
      batch.trigger_id,
      batch.rule,
      batch.group_key,
      batch.automation_id,
      batch.count,
      batch.inputs,
      batch.deliveries,
      batch.first_at,
      batch.last_at,
      batch.close_at,
    )
  }

  dropBatch(batch: Pick<BatchRow, "trigger_id" | "rule" | "group_key">): Promise<void> {
    return this.db.run(
      "DELETE FROM automation_batches WHERE trigger_id = ? AND rule = ? AND group_key = ?",
      batch.trigger_id,
      batch.rule,
      batch.group_key,
    )
  }
}

async function replaceTriggers(
  tx: SqliteExecutor,
  automationId: string,
  triggers: readonly NewTrigger[],
): Promise<void> {
  const kept = triggers.map((trigger) => trigger.id)
  const stale = await tx.all<{ id: string }>("SELECT id FROM automation_triggers WHERE automation_id = ?", automationId)
  for (const row of stale) {
    if (kept.includes(row.id)) continue
    await tx.run("DELETE FROM automation_triggers WHERE id = ?", row.id)
    await tx.run("DELETE FROM automation_batches WHERE trigger_id = ?", row.id)
  }
  for (const [position, trigger] of triggers.entries())
    await tx.run(
      `INSERT INTO automation_triggers (${TRIGGER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET position = excluded.position, kind = excluded.kind, config = excluded.config,
         secret = excluded.secret, next_at = excluded.next_at`,
      trigger.id,
      automationId,
      position,
      trigger.kind,
      trigger.config,
      trigger.secret,
      trigger.next_at,
    )
}
