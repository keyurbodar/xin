import type { Context } from "@deepseek-ai/cordis"
import type { ThreadSettled } from "../../src/contracts/threads.ts"
import type { Catalog } from "../../src/kernel/loader.ts"
import type { Row } from "../../src/kernel/layers.ts"

const KEY = "test.settled"

export function recorded(storage: DurableObjectStorage): readonly ThreadSettled[] {
  return storage.kv.get<ThreadSettled[]>(KEY) ?? []
}

const events = {
  name: "settled",
  inject: ["host"],
  apply(ctx: Context) {
    const storage = ctx.host.state.storage
    ctx.on("thread/settled", (event) => {
      storage.kv.put(KEY, [...recorded(storage), event])
    })
  },
}

export const catalog: Catalog = {
  settled: {
    plugin: events,
    title: "Settled events",
    description: "Records thread/settled events.",
    source: "test",
  },
}

export const rows: readonly Row[] = [{ id: "settled", name: "cordis:settled", disabled: true }]
