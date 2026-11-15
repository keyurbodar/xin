import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type ConversationId,
  type Harness,
  type UsageState,
} from "@earendil-works/pi-durable"
import { compile, map, num, obj, opt, tuple } from "@earendil-works/pi-schema"
import { FEATURES, type Admission, type Feature, type FeatureTracker } from "../../src/contracts/models.ts"
import type { GoalsService } from "../../src/contracts/goals.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { parseWorkspace, WorkspaceDoc } from "../../src/contracts/workspace.ts"

const context = BACKGROUND_CONTEXT
const MARKS = "usage.marks"
const CAPS = "usage.feature.caps"
const FEATURE_PREFIX = /^([a-z]+):(.+)$/

export const FEATURE_MIGRATIONS = [
  {
    version: 1,
    statements: [
      "CREATE TABLE usage_feature (day TEXT NOT NULL, feature TEXT NOT NULL, model TEXT NOT NULL, spend REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, feature, model)) WITHOUT ROWID",
    ],
  },
]

type Amount = { spend: number; tokens: number }
type Cap = { readonly day?: number; readonly month?: number }
type Marks = Record<string, Record<string, readonly [number, number]>>

const CapSchema = obj({ day: opt(num({ minimum: 0 })), month: opt(num({ minimum: 0 })) })
const capsCheck = compile(map(CapSchema))
const marksCheck = compile(map(map(tuple([num(), num()]))))

const zero = (): Amount => ({ spend: 0, tokens: 0 })

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)
const isFeature = (value: string): value is Feature => (FEATURES as readonly string[]).includes(value)

export type FeatureRow = {
  readonly feature: Feature
  readonly model: string
  readonly spend: number
  readonly tokens: number
}

export type BudgetPort = {
  readonly db: SqliteDatabase
  readonly harness: Harness
  readonly goals: () => GoalsService | undefined
}

export type Budget = ReturnType<typeof createBudget>

export function createBudget(port: BudgetPort) {
  const { db, harness } = port
  const trackers = new Set<FeatureTracker>()
  let caps: Record<string, Cap> = {}
  let today = ""
  const spent = new Map<Feature, { today: Amount; month: Amount }>()

  const slot = (feature: Feature): { today: Amount; month: Amount } => {
    const found = spent.get(feature)
    if (found !== undefined) return found
    const fresh = { today: zero(), month: zero() }
    spent.set(feature, fresh)
    return fresh
  }

  async function load(): Promise<void> {
    caps = (await readJson(db, CAPS, capsCheck.check)) ?? {}
    today = dayOf(Date.now())
    spent.clear()
    const rows = await db.all<{ day: string; feature: string; spend: number; tokens: number }>(
      "SELECT day, feature, SUM(spend) AS spend, SUM(tokens) AS tokens FROM usage_feature WHERE day >= ? GROUP BY day, feature",
      `${today.slice(0, 7)}-01`,
    )
    for (const row of rows) {
      if (!isFeature(row.feature)) continue
      const entry = slot(row.feature)
      entry.month.spend += row.spend
      entry.month.tokens += row.tokens
      if (row.day === today) entry.today = { spend: row.spend, tokens: row.tokens }
    }
  }

  function roll(): void {
    const now = dayOf(Date.now())
    if (now === today) return
    const newMonth = now.slice(0, 7) !== today.slice(0, 7)
    today = now
    for (const entry of spent.values()) {
      entry.today = zero()
      if (newMonth) entry.month = zero()
    }
  }

  async function classify(conversation: ConversationId): Promise<Feature> {
    for (const tracker of trackers) if ((await tracker.conversations()).includes(conversation)) return tracker.feature
    if ((await harness.snapshot(ThreadDoc, conversation, context)) === undefined) return "chat"
    const goal = await port.goals()?.get(conversation)
    return goal?.phase === "active" && goal.activation === "armed" ? "goal" : "thread"
  }

  async function conversations(): Promise<ConversationId[]> {
    const listed = new Set<ConversationId>([ROOT_CONVERSATION_ID])
    const workspace = await harness.snapshot(WorkspaceDoc, context)
    if (workspace !== undefined && parseWorkspace.check(workspace))
      for (const space of Object.values(workspace.spaces)) {
        listed.add(space.coordinatorId as ConversationId)
        for (const threadId of space.threadIds) listed.add(threadId as ConversationId)
      }
    for (const tracker of trackers) for (const id of await tracker.conversations()) listed.add(id)
    return [...listed]
  }

  /** Books each conversation's `pi.usage` growth since the last pass under its feature and model; 1 kv row plus 1 row per changed (feature, model). */
  async function record(): Promise<boolean> {
    roll()
    const stored = await readJson(db, MARKS, marksCheck.check)
    const marks: Marks = {}
    const deltas = new Map<string, { feature: Feature; model: string } & Amount>()
    for (const id of await conversations()) {
      const ledger = await harness.snapshot(UsageDoc, id, context)
      if (ledger === undefined) continue
      const own = await classify(id)
      const previous = stored?.[String(id)] ?? {}
      const current: Record<string, readonly [number, number]> = {}
      for (const [key, usage] of Object.entries(ledger.models)) {
        current[key] = [usage.cost.total, usage.totalTokens]
        if (stored === undefined) continue
        const [spend, tokens] = previous[key] ?? [0, 0]
        const delta = { spend: usage.cost.total - spend, tokens: usage.totalTokens - tokens }
        if (delta.spend <= 0 && delta.tokens <= 0) continue
        const tagged = FEATURE_PREFIX.exec(key)
        const feature = tagged !== null && isFeature(tagged[1] ?? "") ? (tagged[1] as Feature) : own
        const model = tagged !== null && isFeature(tagged[1] ?? "") ? (tagged[2] ?? key) : key
        const bucket = `${feature}\u0000${model}`
        const sum = deltas.get(bucket) ?? { feature, model, spend: 0, tokens: 0 }
        sum.spend += delta.spend
        sum.tokens += delta.tokens
        deltas.set(bucket, sum)
      }
      marks[String(id)] = current
    }
    await db.transaction(async (tx) => {
      for (const delta of deltas.values())
        await tx.run(
          "INSERT INTO usage_feature (day, feature, model, spend, tokens) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, feature, model) DO UPDATE SET spend = spend + excluded.spend, tokens = tokens + excluded.tokens",
          today,
          delta.feature,
          delta.model,
          delta.spend,
          delta.tokens,
        )
      if (stored === undefined || deltas.size > 0) await writeJson(tx, MARKS, marks)
    })
    for (const delta of deltas.values()) {
      const entry = slot(delta.feature)
      entry.today.spend += delta.spend
      entry.today.tokens += delta.tokens
      entry.month.spend += delta.spend
      entry.month.tokens += delta.tokens
    }
    return deltas.size > 0
  }

  function admit(feature: Feature): Admission {
    roll()
    const cap = caps[feature]
    if (cap === undefined) return { kind: "ok" }
    const entry = slot(feature)
    if (cap.day !== undefined && entry.today.spend >= cap.day)
      return { kind: "capped", feature, period: "day", spend: entry.today.spend, cap: cap.day }
    if (cap.month !== undefined && entry.month.spend >= cap.month)
      return { kind: "capped", feature, period: "month", spend: entry.month.spend, cap: cap.month }
    return { kind: "ok" }
  }

  /** The compaction hook's pattern: a background call's usage lands in the conversation's `pi.usage`, keyed `<feature>:<provider>/<model>`. */
  function charge(feature: Feature, conversation: ConversationId, message: AssistantMessage): Promise<void> {
    const key = `${feature}:${message.provider}/${message.model}`
    const { usage } = message
    return harness.commit(async (tx) => {
      const models = (await tx.doc(UsageDoc, conversation)).models
      const total = (models[key] ??= {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      })
      total.input += usage.input
      total.output += usage.output
      total.cacheRead += usage.cacheRead
      total.cacheWrite += usage.cacheWrite
      total.totalTokens += usage.totalTokens
      if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h
      if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning
      total.cost.input += usage.cost.input
      total.cost.output += usage.cost.output
      total.cost.cacheRead += usage.cost.cacheRead
      total.cost.cacheWrite += usage.cost.cacheWrite
      total.cost.total += usage.cost.total
    }, context)
  }

  async function setCap(feature: Feature, cap: { day?: number | null; month?: number | null }): Promise<Cap> {
    const previous = caps[feature] ?? {}
    const next: { day?: number; month?: number } = {}
    const day = cap.day === undefined ? previous.day : (cap.day ?? undefined)
    const month = cap.month === undefined ? previous.month : (cap.month ?? undefined)
    if (day !== undefined) next.day = day
    if (month !== undefined) next.month = month
    const updated: Record<string, Cap> = { ...caps }
    if (next.day === undefined && next.month === undefined) delete updated[feature]
    else updated[feature] = next
    await writeJson(db, CAPS, updated as JsonValue)
    caps = updated
    return next
  }

  async function breakdown(): Promise<{ features: JsonValue[]; byModel: JsonValue[] }> {
    roll()
    const rows = await db.all<{ feature: string; model: string; spend: number; tokens: number }>(
      "SELECT feature, model, SUM(spend) AS spend, SUM(tokens) AS tokens FROM usage_feature WHERE day >= ? GROUP BY feature, model",
      `${today.slice(0, 7)}-01`,
    )
    const features = FEATURES.map((feature) => {
      const entry = slot(feature)
      const cap = caps[feature]
      return {
        feature,
        today: { ...entry.today },
        month: { ...entry.month },
        cap: { day: cap?.day ?? null, month: cap?.month ?? null },
        capped: admit(feature).kind === "capped",
      }
    })
    const byModel = rows
      .flatMap((row) => (isFeature(row.feature) ? [row] : []))
      .toSorted((left, right) => right.spend - left.spend || left.model.localeCompare(right.model))
      .map((row) => {
        const slash = row.model.indexOf("/")
        return {
          feature: row.feature,
          provider: slash === -1 ? row.model : row.model.slice(0, slash),
          modelId: slash === -1 ? "" : row.model.slice(slash + 1),
          spend: row.spend,
          tokens: row.tokens,
        }
      })
    return { features, byModel }
  }

  function track(tracker: FeatureTracker): () => void {
    trackers.add(tracker)
    return () => trackers.delete(tracker)
  }

  return { load, record, admit, charge, classify, setCap, breakdown, track, todaySpend: () => spentToday() }

  function spentToday(): { spend: number; capped: Feature[] } {
    roll()
    let spend = 0
    for (const entry of spent.values()) spend += entry.today.spend
    return { spend, capped: FEATURES.filter((feature) => admit(feature).kind === "capped") }
  }
}

/** A conversation's own spend and tokens by model, read from its `pi.usage` in memory. */
export function conversationCost(ledger: UsageState | undefined): {
  spend: number
  tokens: number
  byModel: { model: string; spend: number; tokens: number }[]
} {
  const byModel = Object.entries(ledger?.models ?? {})
    .map(([model, usage]) => ({ model, spend: usage.cost.total, tokens: usage.totalTokens }))
    .toSorted((left, right) => right.spend - left.spend || left.model.localeCompare(right.model))
  return {
    spend: byModel.reduce((sum, row) => sum + row.spend, 0),
    tokens: byModel.reduce((sum, row) => sum + row.tokens, 0),
    byModel,
  }
}

async function readJson<T>(
  db: SqliteExecutor,
  key: string,
  check: (value: unknown) => value is T,
): Promise<T | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)
  if (row === undefined) return undefined
  const value: unknown = JSON.parse(row.value)
  return check(value) ? value : undefined
}

function writeJson(db: SqliteExecutor, key: string, value: JsonValue): Promise<void> {
  return db.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  )
}
