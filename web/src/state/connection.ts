import { createSignal } from "solid-js"
import { Streams } from "../lib/api.ts"

export type Connection = "connecting" | "open" | "closed"

const [connection, setConnection] = createSignal<Connection>("closed")
const [thisSession, setThisSession] = createSignal<string | undefined>(undefined)
let streams: Streams | undefined

export const connectionState = connection

/** The id of this tab's live socket, so a settings list can mark its own row instead of guessing by origin. */
export const sessionId = thisSession

export function connect(): Streams {
  streams ??= new Streams(setConnection, setThisSession)
  streams.open()
  return streams
}

export function disconnect(): void {
  streams?.close()
  streams = undefined
  setThisSession(undefined)
}

/** Bounces the socket after the owner token changed, so the handshake carries the new one. */
export function reauthorize(): void {
  streams?.reconnectNow()
}
