import type { DriveScope } from "../../src/contracts/drive.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

/** Captain scopes by conversation id, set by a test; empty, the row attaches nothing. */
export const captainOf = new Map<number, string>()

export const catalog: Catalog = {
  "drive-scopes": {
    plugin: {
      name: "drive-scopes",
      inject: ["drive"],
      apply(ctx) {
        ctx.effect(() =>
          ctx.drive.attach((conversationId): readonly DriveScope[] => {
            const id = captainOf.get(conversationId)
            return id === undefined ? [] : [{ kind: "captain", id }]
          }),
        )
      },
    },
    title: "Drive scopes",
    description: "test plugin that names a Captain scope per conversation",
    source: "test",
  },
}

export const rows = [{ id: "drive-scopes", name: "cordis:drive-scopes" }]
