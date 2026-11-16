import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"

export const DOC_MAX = 32_768

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE IF NOT EXISTS appearance (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL, rev INTEGER NOT NULL)",
    ],
  },
]

type Stored = { readonly doc: string; readonly rev: number }

const isObjectJson = (text: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** One row per home. `rev` guards against a stale tab overwriting a newer save from another device. */
export function createAppearance(db: SqliteDatabase): readonly Op[] {
  const current = async (): Promise<Stored | undefined> =>
    db.get<Stored>("SELECT doc, rev FROM appearance WHERE id = 1")

  const read = defineOp({
    name: "appearance.read",
    args: obj({}),
    actors: ["owner"],
    read: true,
    run: async () => {
      const row = await current()
      return row === undefined ? { doc: null, rev: 0 } : { doc: row.doc, rev: row.rev }
    },
  })

  const set = defineOp({
    name: "appearance.set",
    args: obj({ doc: str({ minLength: 2, maxLength: DOC_MAX }), rev: opt(int({ minimum: 0 })) }),
    actors: ["owner"],
    run: async (_api, { doc, rev }) => {
      if (!isObjectJson(doc)) throw new OpRejected("bad_args", "appearance doc must be a JSON object")
      const row = await current()
      const stored = row?.rev ?? 0
      if (rev !== undefined && rev !== stored)
        throw new OpRejected("busy", `appearance changed elsewhere (rev ${stored})`, {
          doc: row?.doc ?? null,
          rev: stored,
        })
      const next = stored + 1
      await db.run(
        "INSERT INTO appearance (id, doc, rev) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, rev = excluded.rev",
        doc,
        next,
      )
      return { rev: next }
    },
  })

  return [read, set]
}
