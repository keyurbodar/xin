import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { bool, compile, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import {
  DEFAULT_PREFS,
  DEFAULT_QUIET,
  type Notification,
  type NotifyPrefs,
  type PushService,
  type QuietHours,
} from "../../src/contracts/push.ts"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"
import { serial } from "../../src/serial.ts"
import {
  encryptPayload,
  generateVapid,
  PAYLOAD_LIMIT,
  pushTopic,
  SubscriptionKeys,
  subscriptionCheck,
  type Subscription,
  validSubscriptionKeys,
  vapidAuthorization,
  vapidCheck,
  vapidPublicKey,
  vapidSigner,
  type VapidJwk,
  type VapidSigner,
} from "./webpush.ts"

const VAPID_KEY = "vapid"
const PREFS_KEY = "notify.prefs"
const QUIET_KEY = "notify.quiet"
const HELD_KEY = "notify.held"
const HELD_LIMIT = 20
const WAITING_GRACE_MS = 2 * 60 * 60 * 1000
const HELD_RETRY_MS = 5 * 60_000
const TTL_S = 24 * 60 * 60
const URGENCY = "high"
const PUSH_HEADERS = { "content-encoding": "aes128gcm", "content-type": "application/octet-stream" }
const encoder = new TextEncoder()

export type Fetcher = (request: Request) => Promise<Response>

export type { Notification }
export type Notifier = PushService & {
  /** The next moment a held notification is due, so the clock can wake for it. */
  due(): Promise<number | undefined>
  /** Delivers every held notification whose moment has come; answers how many were sent. */
  flush(at: number): Promise<number>
}

type Held = { readonly releaseAt: number; readonly notification: Notification }

const notificationCheck = compile(
  obj({
    threadTitle: str(),
    title: str(),
    body: opt(str()),
    tag: str(),
    kind: oneOf(["waiting", "finished", "failed", "spend", "schedule"] as const),
  }),
)

export type PushPort = {
  readonly state: Pick<DurableObjectState, "getWebSockets">
  readonly db: SqliteDatabase
}

type Delivery =
  | { readonly kind: "sent" }
  | { readonly kind: "gone" }
  | { readonly kind: "rejected"; readonly status: number }
  | { readonly kind: "unreachable" }

const send: Fetcher = (request) => fetch(request)

export function notifier(port: PushPort, fetcher: Fetcher = send, now: () => number = Date.now): Notifier {
  let signer: Promise<VapidSigner> | undefined
  const serialized = serial()
  const signing = (): Promise<VapidSigner> => {
    signer ??= loadVapid(port.db)
      .then(vapidSigner)
      .catch((failure: unknown) => {
        signer = undefined
        throw failure
      })
    return signer
  }
  const sendNow = async (notification: Notification): Promise<number> =>
    deliverAll(port.db, fetcher, signing, notification)
  return {
    prefs: () => readPrefs(port.db),
    notify: (notification) =>
      serialized(async () => {
        if (port.state.getWebSockets().length > 0) return
        try {
          const quiet = await readQuiet(port.db)
          const at = now()
          if (quiet.enabled && inQuietHours(quiet, at)) {
            await hold(port.db, notification, releaseOf(quiet, at, notification.kind))
            return
          }
          await sendNow(notification)
        } catch (failure) {
          console.warn("push: delivery pass failed", failure)
        }
      }),
    due: async () => {
      const held = await readHeld(port.db)
      return held.length === 0 ? undefined : Math.min(...held.map((item) => item.releaseAt))
    },
    flush: (at) =>
      serialized(async () => {
        const held = await readHeld(port.db)
        const due = held.filter((item) => item.releaseAt <= at)
        if (due.length === 0) return 0
        // A connected client has the notification already, so its due items are dropped rather than sent late.
        if (port.state.getWebSockets().length > 0) {
          await writeHeld(
            port.db,
            held.filter((item) => item.releaseAt > at),
          )
          return 0
        }
        // Send first, then rewrite the held list: a send that throws keeps its notification for a retry instead of
        // dropping it with the ones that were delivered.
        const keep = held.filter((item) => item.releaseAt > at)
        let sent = 0
        for (const item of due) {
          try {
            sent += await sendNow(item.notification)
          } catch (failure) {
            console.warn("push: held delivery failed", failure)
            keep.push({ ...item, releaseAt: at + HELD_RETRY_MS })
          }
        }
        await writeHeld(port.db, keep)
        return sent
      }),
  }
}

/** When a held notification is due: a question after two hours paused, everything else when quiet ends. */
function releaseOf(quiet: QuietHours, at: number, kind: Notification["kind"]): number {
  const end = quietEnd(quiet, at)
  return kind === "waiting" ? Math.min(at + WAITING_GRACE_MS, end) : end
}

/** The next moment the window is over: today's end when it is still ahead, otherwise tomorrow's. */
function quietEnd(quiet: QuietHours, at: number): number {
  const midnight = Math.floor(at / 86_400_000) * 86_400_000
  const endToday = midnight + quiet.end * 60_000
  return endToday > at ? endToday : endToday + 86_400_000
}

function hold(db: SqliteDatabase, notification: Notification, releaseAt: number): Promise<void> {
  return readHeld(db).then((held) => writeHeld(db, [...held, { releaseAt, notification }].slice(-HELD_LIMIT)))
}

function readHeld(db: SqliteDatabase): Promise<Held[]> {
  return db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", HELD_KEY).then((row) => {
    if (row === undefined) return []
    const parsed: unknown = parseJson(row.value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): Held[] => {
      if (typeof item !== "object" || item === null) return []
      const record = item as Record<string, unknown>
      const releaseAt = record.releaseAt
      const notification = record.notification
      if (typeof releaseAt !== "number") return []
      if (!notificationCheck.check(notification)) return []
      return [{ releaseAt, notification }]
    })
  })
}

async function writeHeld(db: SqliteDatabase, held: readonly Held[]): Promise<void> {
  if (held.length === 0) {
    await db.run("DELETE FROM kv WHERE key = ?", HELD_KEY)
    return
  }
  await db.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    HELD_KEY,
    JSON.stringify(held),
  )
}

export function pushOps(db: SqliteDatabase, fetcher: Fetcher = send): readonly Op[] {
  return [
    defineOp({
      name: "push.key",
      args: obj({}),
      actors: ["owner"],
      run: async () => ({ applicationServerKey: vapidPublicKey(await loadVapid(db)) }),
    }),
    defineOp({
      name: "notify.prefs",
      args: obj({}),
      actors: ["owner"],
      run: async () => readPrefs(db),
    }),
    defineOp({
      name: "notify.set",
      args: obj({
        waiting: opt(bool()),
        finished: opt(bool()),
        failed: opt(bool()),
        spend: opt(bool()),
        schedule: opt(bool()),
      }),
      actors: ["owner"],
      run: async (_api, args) => {
        const current = await readPrefs(db)
        const next: NotifyPrefs = {
          waiting: args.waiting ?? current.waiting,
          finished: args.finished ?? current.finished,
          failed: args.failed ?? current.failed,
          spend: args.spend ?? current.spend,
          schedule: args.schedule ?? current.schedule,
        }
        await db.run(
          "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          PREFS_KEY,
          JSON.stringify(next),
        )
        return next
      },
    }),
    defineOp({
      name: "notify.quiet",
      args: obj({}),
      actors: ["owner"],
      run: async () => readQuiet(db),
    }),
    defineOp({
      name: "notify.quiet.set",
      args: obj({
        enabled: opt(bool()),
        start: opt(int({ minimum: 0, maximum: 1439 })),
        end: opt(int({ minimum: 0, maximum: 1439 })),
      }),
      actors: ["owner"],
      run: async (_api, args) => {
        const current = await readQuiet(db)
        const next: QuietHours = {
          enabled: args.enabled ?? current.enabled,
          start: args.start ?? current.start,
          end: args.end ?? current.end,
        }
        await db.run(
          "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          QUIET_KEY,
          JSON.stringify(next),
        )
        return next
      },
    }),
    defineOp({
      name: "push.test",
      args: obj({}),
      actors: ["owner"],
      run: async () => ({ sent: await testPush(db, fetcher) }),
    }),
    defineOp({
      name: "push.subscribe",
      args: obj({
        endpoint: str({ minLength: 1, maxLength: 2048 }),
        keys: SubscriptionKeys,
      }),
      actors: ["owner"],
      run: async (_api, args) => {
        if (!httpsEndpoint(args.endpoint)) throw new OpRejected("bad_args", "push endpoint must be https")
        if (!(await validSubscriptionKeys(args.keys)))
          throw new OpRejected("bad_args", "push subscription keys are invalid")
        await db.run(
          "INSERT INTO push_subs (endpoint, keys) VALUES (?, ?) ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys",
          args.endpoint,
          JSON.stringify(args.keys),
        )
        return { endpoint: args.endpoint }
      },
    }),
    defineOp({
      name: "push.list",
      args: obj({}),
      actors: ["owner"],
      run: async () => {
        const rows = await db.all<{ endpoint: string }>("SELECT endpoint FROM push_subs ORDER BY endpoint")
        return rows.map((row) => ({ endpoint: row.endpoint, origin: origin(row.endpoint) }))
      },
    }),
    defineOp({
      name: "push.unsubscribe",
      args: obj({ endpoint: str({ minLength: 1, maxLength: 2048 }) }),
      actors: ["owner"],
      run: async (_api, args) => {
        await db.run("DELETE FROM push_subs WHERE endpoint = ?", args.endpoint)
        return { endpoint: args.endpoint }
      },
    }),
  ]
}

export async function readPrefs(db: SqliteDatabase): Promise<NotifyPrefs> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", PREFS_KEY)
  if (row === undefined) return DEFAULT_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch {
    return DEFAULT_PREFS
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS
  const record = parsed as Record<string, unknown>
  return {
    waiting: record.waiting === false ? false : DEFAULT_PREFS.waiting,
    finished: record.finished === false ? false : DEFAULT_PREFS.finished,
    failed: record.failed === false ? false : DEFAULT_PREFS.failed,
    spend: record.spend === false ? false : DEFAULT_PREFS.spend,
    schedule: record.schedule === true,
  }
}

export async function readQuiet(db: SqliteDatabase): Promise<QuietHours> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", QUIET_KEY)
  if (row === undefined) return DEFAULT_QUIET
  const parsed: unknown = parseJson(row.value)
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_QUIET
  const record = parsed as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    start: minuteOfDay(record.start) ?? DEFAULT_QUIET.start,
    end: minuteOfDay(record.end) ?? DEFAULT_QUIET.end,
  }
}

function minuteOfDay(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439 ? value : undefined
}

/** A window whose start is past its end wraps midnight; equal ends mean all day. */
function inQuietHours(quiet: QuietHours, now: number): boolean {
  if (!quiet.enabled) return false
  const minute = Math.floor(now / 60_000) % 1440
  if (quiet.start === quiet.end) return true
  if (quiet.start < quiet.end) return minute >= quiet.start && minute < quiet.end
  return minute >= quiet.start || minute < quiet.end
}

/** One notification to every subscribed browser, sockets or not: the owner asked to see it arrive. */
export function testPush(db: SqliteDatabase, fetcher: Fetcher = send): Promise<number> {
  return deliverAll(db, fetcher, () => loadVapid(db).then(vapidSigner), {
    threadTitle: "Xin",
    title: "Push works",
    body: "This is a test notification from Xin.",
    tag: "test",
    kind: "finished",
  })
}

async function deliverAll(
  db: SqliteDatabase,
  fetcher: Fetcher,
  signing: () => Promise<VapidSigner>,
  notification: Notification,
): Promise<number> {
  const subscriptions = await readSubscriptions(db)
  if (subscriptions.length === 0) return 0
  const topic = await pushTopic(notification.tag)
  const payload = fitNotification(notification)
  const results = await Promise.allSettled(
    subscriptions.map((subscription) => deliver(fetcher, signing, topic, payload, subscription)),
  )
  let sent = 0
  for (const [index, result] of results.entries()) {
    const subscription = subscriptions[index]
    if (subscription === undefined) continue
    const delivery: Delivery = result.status === "fulfilled" ? result.value : { kind: "unreachable" }
    switch (delivery.kind) {
      case "sent":
        sent += 1
        break
      case "gone":
        await db.run("DELETE FROM push_subs WHERE endpoint = ?", subscription.endpoint)
        break
      case "rejected":
        console.warn(`push: ${origin(subscription.endpoint)} answered ${delivery.status}`)
        break
      case "unreachable":
        console.warn(`push: ${origin(subscription.endpoint)} unreachable`)
        break
    }
  }
  return sent
}

async function deliver(
  fetcher: Fetcher,
  signing: () => Promise<VapidSigner>,
  topic: string,
  payload: Uint8Array,
  subscription: Subscription,
): Promise<Delivery> {
  try {
    const body = await encryptPayload(subscription, payload)
    const authorization = await vapidAuthorization(await signing(), new URL(subscription.endpoint).origin)
    const response = await fetcher(
      new Request(subscription.endpoint, {
        method: "POST",
        headers: { ...PUSH_HEADERS, authorization, ttl: String(TTL_S), urgency: URGENCY, topic },
        body,
      }),
    )
    if (response.status === 404 || response.status === 410) return { kind: "gone" }
    if (!response.ok) return { kind: "rejected", status: response.status }
    return { kind: "sent" }
  } catch {
    return { kind: "unreachable" }
  }
}

async function readSubscriptions(db: SqliteDatabase): Promise<readonly Subscription[]> {
  const rows = await db.all<{ endpoint: string; keys: string }>("SELECT endpoint, keys FROM push_subs")
  const subscriptions: Subscription[] = []
  for (const row of rows) {
    const candidate: unknown = { endpoint: row.endpoint, keys: parseJson(row.keys) }
    if (subscriptionCheck.check(candidate)) {
      subscriptions.push(candidate)
      continue
    }
    console.warn(`push: dropping stored subscription with invalid keys for ${origin(row.endpoint)}`)
    await db.run("DELETE FROM push_subs WHERE endpoint = ?", row.endpoint)
  }
  return subscriptions
}

function fitNotification(notification: Notification): Uint8Array {
  let threadTitle = notification.threadTitle
  let title = notification.title
  let body = notification.body
  for (let attempt = 0; attempt < 24; attempt++) {
    const payload = encodeNotification(threadTitle, title, body, notification.tag)
    const excess = payload.length - PAYLOAD_LIMIT
    if (excess <= 0) return payload
    if (body !== undefined) {
      const next = clampText(body, encoder.encode(body).length - excess)
      body = next === "" ? undefined : next
      continue
    }
    if (title !== "") {
      title = clampText(title, encoder.encode(title).length - excess)
      continue
    }
    threadTitle = clampText(threadTitle, encoder.encode(threadTitle).length - excess)
  }
  return encodeNotification("", "", undefined, notification.tag)
}

function encodeNotification(threadTitle: string, title: string, body: string | undefined, tag: string): Uint8Array {
  return encoder.encode(
    JSON.stringify(body === undefined ? { threadTitle, title, tag } : { threadTitle, title, body, tag }),
  )
}

function clampText(text: string, maxBytes: number): string {
  let used = 0
  let kept = ""
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > maxBytes) break
    kept += char
    used += size
  }
  return kept
}

async function loadVapid(db: SqliteDatabase): Promise<VapidJwk> {
  const existing = await readVapid(db)
  if (existing !== undefined) return existing
  const created = await generateVapid()
  await db.run("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)", VAPID_KEY, JSON.stringify(created))
  const stored = await readVapid(db)
  if (stored === undefined) throw new Error("vapid key was not stored")
  return stored
}

async function readVapid(db: SqliteDatabase): Promise<VapidJwk | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", VAPID_KEY)
  if (row === undefined) return undefined
  const parsed: unknown = parseJson(row.value)
  if (!vapidCheck.check(parsed)) throw new Error("stored vapid key is invalid")
  return parsed
}

function httpsEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === "https:"
  } catch {
    return false
  }
}

function origin(endpoint: string): string {
  try {
    return new URL(endpoint).origin
  } catch {
    return "invalid endpoint"
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
