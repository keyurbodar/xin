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
import { compile, map, num, obj, opt, str, tuple } from "@earendil-works/pi-schema"
import { FEATURES, type Admission, type Feature, type FeatureTracker } from "../../src/contracts/models.ts"
import type { GoalsService } from "../../src/contracts/goals.ts"
import { PuckDoc } from "../../src/contracts/puck.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { parseWorkspace, WorkspaceDoc } from "../../src/contracts/workspace.ts"

const context = BACKGROUND_CONTEXT
const MARKS = "usage.marks"
const CAPS = "usage.feature.caps"
const FEATURE_PREFIX = /^([a-z]+):(.+)$/
const TOOL_PREFIX = "tool/"

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
type Marks = Record<string, Record<string, [number, number]>>
type Delta = { feature: Feature; model: string } & Amount

const CapSchema = obj({ day: opt(num({ minimum: 0 })), month: opt(num({ minimum: 0 })) })
const capsCheck = compile(map(CapSchema))
const Pair = tuple([num(), num()])
const ledgerCheck = compile(obj({ marks: map(map(Pair)), day: str(), totals: map(obj({ today: Pair, month: Pair })) }))
/** Rows the owner's model breakdown reads at most; the month's feature totals come from memory. */
const BREAKDOWN_ROWS = 100

const zero = (): Amount => ({ spend: 0, tokens: 0 })

const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)
const isFeature = (value: string): value is Feature => (FEATURES as readonly string[]).includes(value)

/** A `pi.usage` model key and the feature it was charged to, when `charge` tagged it `<feature>:<provider>/<model>`. */
export function untag(key: string): { readonly feature: Feature | undefined; readonly model: string } {
  const tagged = FEATURE_PREFIX.exec(key)
  const feature = tagged?.[1]
  return feature !== undefined && isFeature(feature)
    ? { feature, model: tagged?.[2] ?? key }
    : { feature: undefined, model: key }
}

export type FeatureRow = {
  readonly feature: Feature
  readonly model: string
  readonly spend: number
  readonly tokens: number
}

export type BudgetPort = {
  readonly db: SqliteDatabase
  readonly harness: Harness
  readonly conversations: () => Promise<readonly ConversationId[]>
  readonly goals: () => GoalsService | undefined
}

export type Budget = ReturnType<typeof createBudget>

export function createBudget(port: BudgetPort) {
  const { db, harness } = port
  const trackers = new Set<FeatureTracker>()
  let caps: Record<string, Cap> = {}
  let today = ""
  let marks: Marks | undefined
  const spent = new Map<Feature, { today: Amount; month: Amount }>()

  const slot = (feature: Feature): { today: Amount; month: Amount } => {
    const found = spent.get(feature)
    if (found !== undefined) return found
    const fresh = { today: zero(), month: zero() }
    spent.set(feature, fresh)
    return fresh
  }

  /** 2 kv rows: the caps, and the marks with this month's feature totals, so a boot never scans `usage_feature`. */
  async function load(): Promise<void> {
    caps = (await readJson(db, CAPS, capsCheck.check)) ?? {}
    const stored = await readJson(db, MARKS, ledgerCheck.check)
    marks = stored?.marks
    spent.clear()
    today = stored?.day ?? dayOf(Date.now())
    for (const [feature, total] of Object.entries(stored?.totals ?? {}))
      if (isFeature(feature))
        spent.set(feature, {
          today: { spend: total.today[0], tokens: total.today[1] },
          month: { spend: total.month[0], tokens: total.month[1] },
        })
    roll()
  }

  const totals = (): Record<string, { today: [number, number]; month: [number, number] }> =>
    Object.fromEntries(
      [...spent].map(([feature, entry]) => [
        feature,
        { today: [entry.today.spend, entry.today.tokens], month: [entry.month.spend, entry.month.tokens] },
      ]),
    )

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

  /**
   * A tracked conversation takes its tracker's feature. A chat (the root, a Puck chat, a project coordinator) or a thread
   * running an armed goal is `goal`; otherwise a thread is `thread` and a chat is `chat`. Anything else is `other`, so
   * the features sum to the session ledger. Only a chat or a thread pays the goal lookup's row.
   */
  async function classify(conversation: ConversationId): Promise<Feature> {
    for (const tracker of trackers) if ((await tracker.conversations()).includes(conversation)) return tracker.feature
    const base =
      (await harness.snapshot(ThreadDoc, conversation, context)) !== undefined
        ? "thread"
        : (await chats()).has(String(conversation))
          ? "chat"
          : "other"
    if (base === "other") return base
    const goal = await port.goals()?.get(conversation)
    return goal?.phase === "active" && goal.activation === "armed" ? "goal" : base
  }

  async function chats(): Promise<Set<string>> {
    const listed = new Set<string>([String(ROOT_CONVERSATION_ID)])
    const puck = await harness.snapshot(PuckDoc, context)
    for (const id of Object.keys(puck?.conversations ?? {})) listed.add(id)
    const workspace = await harness.snapshot(WorkspaceDoc, context)
    if (workspace !== undefined && parseWorkspace.check(workspace))
      for (const space of Object.values(workspace.spaces)) listed.add(String(space.coordinatorId))
    return listed
  }

  /** Classifications made since the last flush; the flush that books them consumes them, so an admit costs no extra row. */
  const classes = new Map<ConversationId, Feature>()
  const featureOf = async (conversation: ConversationId): Promise<Feature> => {
    const known = classes.get(conversation)
    if (known !== undefined) return known
    const feature = await classify(conversation)
    classes.set(conversation, feature)
    return feature
  }

  /** Every conversation's `pi.usage` growth past `marks`, models and tools alike, by (feature, model). */
  async function measure(): Promise<{ next: Marks; deltas: Map<string, Delta> }> {
    const next: Marks = {}
    const deltas = new Map<string, Delta>()
    for (const id of await port.conversations()) {
      const ledger = await harness.snapshot(UsageDoc, id, context)
      if (ledger === undefined) continue
      const previous = marks?.[String(id)] ?? {}
      const current: Record<string, [number, number]> = {}
      const buckets = [
        ...Object.entries(ledger.models),
        ...Object.entries(ledger.tools).map(([name, usage]) => [`${TOOL_PREFIX}${name}`, usage] as const),
      ]
      for (const [key, usage] of buckets) {
        current[key] = [usage.cost.total, usage.totalTokens]
        if (marks === undefined) continue
        const [spend, tokens] = previous[key] ?? [0, 0]
        const delta = { spend: usage.cost.total - spend, tokens: usage.totalTokens - tokens }
        if (delta.spend <= 0 && delta.tokens <= 0) continue
        const tagged = untag(key)
        const feature = tagged.feature ?? (await featureOf(id))
        const bucket = `${feature}\u0000${tagged.model}`
        const sum = deltas.get(bucket) ?? { feature, model: tagged.model, spend: 0, tokens: 0 }
        sum.spend += delta.spend
        sum.tokens += delta.tokens
        deltas.set(bucket, sum)
      }
      next[String(id)] = current
    }
    return { next, deltas }
  }

  /** Books the growth since the last pass: 1 kv row plus 1 row per changed (feature, model), and nothing when idle. */
  let recording: Promise<boolean> = Promise.resolve(false)
  /** Passes run one at a time, so two flushes never book the same growth against the same marks. */
  function record(): Promise<boolean> {
    const pass = recording.then(book, book)
    recording = pass.catch(() => false)
    return pass
  }

  async function book(): Promise<boolean> {
    roll()
    const { next, deltas } = await measure()
    const before = new Map([...spent].map(([feature, entry]) => [feature, structuredClone(entry)] as const))
    for (const delta of deltas.values()) {
      const entry = slot(delta.feature)
      entry.today.spend += delta.spend
      entry.today.tokens += delta.tokens
      entry.month.spend += delta.spend
      entry.month.tokens += delta.tokens
    }
    try {
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
        if (marks === undefined || deltas.size > 0)
          await writeJson(tx, MARKS, { marks: next, day: today, totals: totals() })
      })
    } catch (error) {
      spent.clear()
      for (const [feature, entry] of before) spent.set(feature, entry)
      throw error
    }
    marks = next
    classes.clear()
    return deltas.size > 0
  }

  function check(feature: Feature, pending: number): Admission {
    roll()
    const cap = caps[feature]
    if (cap === undefined) return { kind: "ok" }
    const entry = slot(feature)
    const day = entry.today.spend + pending
    const month = entry.month.spend + pending
    if (cap.day !== undefined && day >= cap.day)
      return { kind: "capped", feature, period: "day", spend: day, cap: cap.day }
    if (cap.month !== undefined && month >= cap.month)
      return { kind: "capped", feature, period: "month", spend: month, cap: cap.month }
    return { kind: "ok" }
  }

  /** Flushed spend plus what the session ledger grew by since the last flush, measured in memory. */
  async function admit(feature: Feature): Promise<Admission> {
    if (caps[feature] === undefined) return { kind: "ok" }
    let pending = 0
    for (const delta of (await measure()).deltas.values()) if (delta.feature === feature) pending += delta.spend
    return check(feature, pending)
  }
  /** The compaction hook's pattern: a background call's usage lands in the conversation's `pi.usage`, keyed `<feature>:<provider>/<model>`. */
  function charge(feature: Feature, conversation: ConversationId, message: AssistantMessage): Promise<void> {
    const key = `${feature}:${message.provider}/${message.model}`
    const { usage } = message
    return harness.commit(async (tx) => {
      const models = (await tx.doc(UsageDoc, conversation)).models
      if (!Object.hasOwn(models, key))
        models[key] = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }
      const total = models[key]
      if (total === undefined) return
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

  async function setCap(
    feature: Feature,
    cap: { day?: number | null | undefined; month?: number | null | undefined },
  ): Promise<Cap> {
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

  /** Each feature's day and month from memory, with its cap; reads no row. */
  function features(): JsonValue[] {
    roll()
    return FEATURES.map((feature) => {
      const entry = slot(feature)
      const cap = caps[feature]
      return {
        feature,
        today: { ...entry.today },
        month: { ...entry.month },
        cap: { day: cap?.day ?? null, month: cap?.month ?? null },
        capped: check(feature, 0).kind === "capped",
      }
    })
  }

  /** `features()` plus this month's spend by (feature, model), the `BREAKDOWN_ROWS` largest. */
  async function breakdown(): Promise<{ features: JsonValue[]; byModel: JsonValue[] }> {
    const rows = await db.all<{ feature: string; model: string; spend: number; tokens: number }>(
      "SELECT feature, model, SUM(spend) AS spend, SUM(tokens) AS tokens FROM usage_feature WHERE day >= ? GROUP BY feature, model ORDER BY spend DESC, model LIMIT ?",
      `${today.slice(0, 7)}-01`,
      BREAKDOWN_ROWS,
    )
    const byModel = rows
      .flatMap((row) => (isFeature(row.feature) ? [row] : []))
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
    return { features: features(), byModel }
  }

  function track(tracker: FeatureTracker): () => void {
    trackers.add(tracker)
    return () => {
      trackers.delete(tracker)
    }
  }

  /** A home with no marks yet records its current ledger as the baseline, booking nothing; no row otherwise. */
  async function seed(): Promise<void> {
    if (marks === undefined) await record()
  }

  return {
    load,
    record,
    seed,
    admit,
    charge,
    classify: featureOf,
    setCap,
    breakdown,
    features,
    track,
    todaySpend: () => spentToday(),
    /** With no cap set there is nothing to check, so the conversation is not classified and no row is read. */
    admitConversation: async (conversation: ConversationId): Promise<Admission> =>
      Object.keys(caps).length === 0 ? { kind: "ok" } : admit(await featureOf(conversation)),
  }

  function spentToday(): { spend: number; capped: Feature[] } {
    roll()
    let spend = 0
    for (const entry of spent.values()) spend += entry.today.spend
    return { spend, capped: FEATURES.filter((feature) => check(feature, 0).kind === "capped") }
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
