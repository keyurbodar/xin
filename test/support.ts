import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import type { Home } from "./worker.ts"

export const fresh = (): DurableObjectStub<Home> => env.HOME.get(env.HOME.newUniqueId())

export async function eventually(
  stub: DurableObjectStub<Home>,
  check: (home: Home, state: DurableObjectState) => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await runInDurableObject(stub, check)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition not reached")
}

export const OWNER = "test-owner-token"
export const owner = (): DurableObjectStub<Home> => env.HOME.get(env.HOME.idFromName("owner"))

export const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new Request(`https://xin.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", ...init?.headers },
    }),
  )

export type Socket = {
  send(frame: unknown): void
  next(match: (frame: Frame) => boolean): Promise<Frame>
  close(): void
}
export type Frame = { readonly t?: string; readonly [key: string]: unknown }

export async function connect(): Promise<Socket> {
  const reply = await exports.default.fetch(
    new Request("https://xin.test/v1/socket", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `xin, bearer.${OWNER}` },
    }),
  )
  const ws = reply.webSocket
  if (ws === null) throw new Error(`no socket: ${reply.status}`)
  ws.accept()
  const frames: Frame[] = []
  const waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = []
  ws.addEventListener("message", (event) => {
    const frame: Frame = JSON.parse(String(event.data))
    const waiter = waiters.find((w) => w.match(frame))
    if (waiter === undefined) frames.push(frame)
    else {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(frame)
    }
  })
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (match) => {
      const index = frames.findIndex(match)
      if (index !== -1) return Promise.resolve(frames.splice(index, 1)[0] as Frame)
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error("no matching frame within 5s")), 5000)
      })
    },
    close: () => ws.close(),
  }
}
