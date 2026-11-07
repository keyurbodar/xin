import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { bool, obj, opt, str } from "@earendil-works/pi-schema"
import {
  DEFAULT_PREFS,
  type Notification,
  type NotifyPrefs,
  type PushService,
} from "../../src/contracts/push.ts"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"
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
const TTL_S = 24 * 60 * 60
const URGENCY = "high"
const PUSH_HEADERS = { "content-encoding": "aes128gcm", "content-type": "application/octet-stream" }
const encoder = new TextEncoder()

export type Fetcher = (request: Request) => Promise<Response>

export type { Notification }
export type Notifier = PushService

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

export function notifier(port: PushPort, fetcher: Fetcher = send): Notifier {
  let signer: Promise<VapidSigner> | undefined
  const signing = (): Promise<VapidSigner> => {
    signer ??= loadVapid(port.db)
      .then(vapidSigner)
      .catch((failure: unknown) => {
        signer = undefined
        throw failure
      })
    return signer
  }
  return {
    prefs: () => readPrefs(port.db),
    notify: async (notification) => {
      if (port.state.getWebSockets().length > 0) return
      try {
        await deliverAll(port.db, fetcher, signing, notification)
      } catch (failure) {
        console.warn("push: delivery pass failed", failure)
      }
    },
  }
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
      args: obj({ waiting: opt(bool()), finished: opt(bool()), failed: opt(bool()) }),
      actors: ["owner"],
      run: async (_api, args) => {
        const current = await readPrefs(db)
        const next: NotifyPrefs = {
          waiting: args.waiting ?? current.waiting,
          finished: args.finished ?? current.finished,
          failed: args.failed ?? current.failed,
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
  }
}

/** One notification to every subscribed browser, sockets or not: the owner asked to see it arrive. */
export function testPush(db: SqliteDatabase, fetcher: Fetcher = send): Promise<number> {
  return deliverAll(db, fetcher, () => loadVapid(db).then(vapidSigner), {
    threadTitle: "Xin",
    title: "Push works",
    body: "This is a test notification from Xin.",
    tag: "test",
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
