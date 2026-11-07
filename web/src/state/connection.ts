import { createSignal } from "solid-js"
import { Streams } from "../lib/api.ts"

export type Connection = "connecting" | "open" | "closed"

const [connection, setConnection] = createSignal<Connection>("closed")
let streams: Streams | undefined

export const connectionState = connection

export function connect(): Streams {
  streams ??= new Streams(setConnection)
  streams.open()
  return streams
}

export function disconnect(): void {
  streams?.close()
  streams = undefined
}
