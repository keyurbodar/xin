import { runInDurableObject } from "cloudflare:test"
import type { SqliteMigration } from "@earendil-works/chord/sqlite"
import { describe, expect, it } from "vitest"
import { fresh } from "../../test/support.ts"
import { tableOwner } from "./dbtables.ts"
import type { Home } from "../../test/worker.ts"

const STEPS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: ["CREATE TABLE probe_items (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)"],
  },
]

describe("db migrations", () => {
  it("assigns every table a plugin writes to that plugin", () => {
    expect(tableOwner("market_history")).toBe("market")
    expect(tableOwner("usage_daily")).toBe("models")
    expect(tableOwner("file_revisions")).toBe("files")
    expect(tableOwner("conversation_presets")).toBe("presets")
    // Nothing reads the old plugin row table, so it is not owned by anyone any more.
    expect(tableOwner("plugins")).toBeUndefined()
  })
  it("applies one owner's steps once and stays idempotent", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      await home.db.applySqliteMigrations("probe", STEPS)
      await home.db.run("INSERT INTO probe_items (at) VALUES (?)", 1)
      await home.db.applySqliteMigrations("probe", STEPS)
      expect(await home.db.all<{ count: number }>("SELECT COUNT(*) AS count FROM probe_items")).toEqual([{ count: 1 }])
      expect(await home.db.all<{ version: number }>("SELECT version FROM migrations_probe")).toEqual([{ version: 1 }])
    })
  })
})
