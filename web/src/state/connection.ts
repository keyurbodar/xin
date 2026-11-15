import { createSignal } from "solid-js"
import { Streams } from "../lib/api.ts"

export type Connection = "connecting" | "open" | "closed"

const [connection, setConnection] = createSignal<Connection>("closed")
const [thisSession, setThisSession] = createSignal<string | undefined>(undefined)
const [retryAt, setRetryAt] = createSignal<number | undefined>(undefined)
const [lastOpen, setLastOpen] = createSignal<number | undefined>(undefined)
const [downSince, setDownSince] = createSignal<number | undefined>(undefined)
const [online, setOnline] = createSignal(navigator.onLine)
let streams: Streams | undefined

export const connectionState = connection

/** The id of this tab's live socket, so a settings list can mark its own row instead of guessing by origin. */
export const sessionId = thisSession

/** When the socket dials again on its own, so the offline screen can count down to it. */
export const nextRetry = retryAt

/** The last moment the socket was open; undefined until it first opens. */
export const lastConnected = lastOpen

/** Since when this tab has had no open socket, counted from the first dial; undefined while one is open. */
export const disconnectedSince = downSince

export const networkOnline = online

export function connect(): Streams {
  if (streams === undefined) {
    const opened = new Streams(
      (status) => {
        if (status === "open") {
          setDownSince(undefined)
          setRetryAt(undefined)
        } else if (connection() === "open") {
          setLastOpen(Date.now())
          setDownSince(Date.now())
        }
        setConnection(status)
      },
      setThisSession,
      setRetryAt,
    )
    window.addEventListener("online", () => {
      setOnline(true)
      opened.dialNow()
    })
    window.addEventListener("offline", () => setOnline(false))
    streams = opened
    setDownSince(Date.now())
  }
  streams.open()
  return streams
}

/** Dials now when no socket is open, as one chain with the pending backoff. */
export function dialNow(): void {
  streams?.dialNow()
}

/** Bounces the socket after the owner token changed, so the handshake carries the new one. */
export function reauthorize(): void {
  streams?.reconnectNow()
}
