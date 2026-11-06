import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
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
