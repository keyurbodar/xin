import { createSignal } from "solid-js"
import { Streams } from "../lib/api.ts"
import { setToken } from "../lib/auth.ts"

export type Connection = "connecting" | "open" | "closed"

const [connection, setConnection] = createSignal<Connection>("closed")
const [thisSession, setThisSession] = createSignal<string | undefined>(undefined)
let streams: Streams | undefined

export const connectionState = connection

/** The id of this tab's live socket, so a settings list can mark its own row instead of guessing by origin. */
export const sessionId = thisSession

/** The server refused this tab's token, so it is dropped and the tab reopens on sign-in. */
function signOut(): void {
  setToken("")
  location.reload()
}

export function connect(): Streams {
  streams ??= new Streams(setConnection, setThisSession, signOut)
  streams.open()
  return streams
}

/** Bounces the socket after the owner token changed, so the handshake carries the new one. */
export function reauthorize(): void {
  streams?.reconnectNow()
}
