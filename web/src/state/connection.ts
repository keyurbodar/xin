import { createSignal } from "solid-js"
import { Streams } from "../lib/api.ts"
import { setToken } from "../lib/auth.ts"

export type Connection = "connecting" | "open" | "closed"

const [connection, setConnection] = createSignal<Connection>("closed")
const [thisSession, setThisSession] = createSignal<string | undefined>(undefined)
const [retryAt, setRetryAt] = createSignal<number | undefined>(undefined)
const [lastOpen, setLastOpen] = createSignal<number | undefined>(undefined)
const [downSince, setDownSince] = createSignal<number | undefined>(undefined)
const [online, setOnline] = createSignal(navigator.onLine)
const [held, setHeld] = createSignal(false)
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

/** The socket is closed on purpose while a retired token is shown, so its silence is no outage. */
export const connectionHeld = held

/** The server refused this tab's token, so it is dropped and the tab reopens on sign-in. */
function signOut(): void {
  setToken("")
  location.reload()
}

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
      signOut,
      (holding) => {
        setHeld(holding)
        if (!holding && connection() !== "open") setDownSince(Date.now())
      },
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

/** Keeps the socket closed while this tab's token is being retired on purpose; a new stored token resumes it. */
export function holdConnection(): void {
  streams?.pause()
}

/** Ends a hold whose rotation failed, so the socket redials with the token it already had. */
export function releaseConnection(): void {
  streams?.resume()
}

/** Bounces the socket after the owner token changed, so the handshake carries the new one. */
export function reauthorize(): void {
  streams?.reconnectNow()
}
