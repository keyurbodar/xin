import type { SqliteExecutor } from "@earendil-works/chord/sqlite"
import { defineExtension } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import type { MemoryService, Note } from "../../src/contracts/memory.ts"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { defineOp, type Op } from "../../src/ops.ts"
import {
  appendNote,
  CURSOR_KEY,
  DUE_KEY,
  dreamerTask,
  ensurePass,
  IDLE_MS,
  readNumber,
  readProfile,
  requestPass,
  writeKv,
} from "./dreamer.ts"
import { SCOPE_PATTERN } from "./dreamprompt.ts"

const RECALL_LIMIT = 20
const LIST_LIMIT = 100
const OWNER_RETIREMENT = 0

export function create(deps: ModuleDeps): HostModule {
  const memory: MemoryService = {
    remember: async (draft) => {
      const inserted = await appendNote(deps.db, draft)
      await requestPass(deps, draft.at + IDLE_MS)
      return inserted
    },
    search: (query, scopes, now, limit) => searchNotes(deps.db, query, scopes, now, limit),
    profile: () => readProfile(deps.db),
  }

  return {
    provides: { memory },
    extensions: [defineExtension({ name: "memory", tasks: [dreamerTask(deps)] })],
    ops: [forget(deps), list(deps), profile(deps)],
    start: async () => {
      const cursor = (await readNumber(deps.db, CURSOR_KEY)) ?? 0
      const newest = await deps.db.get<{ at: number }>(
        "SELECT at FROM notes WHERE id > ? AND retired_by IS NULL AND source != 'dreamer' ORDER BY at DESC LIMIT 1",
        cursor,
      )
      const due = await readNumber(deps.db, DUE_KEY)
      const idle = newest === undefined ? undefined : newest.at + IDLE_MS
      const at = idle === undefined ? due : due === undefined ? idle : Math.min(idle, due)
      if (at !== undefined) await ensurePass(deps, at)
    },
    due: () => readNumber(deps.db, DUE_KEY),
    fire: async (now) => {
      const due = await readNumber(deps.db, DUE_KEY)
      if (due === undefined || due > now) return
      await writeKv(deps.db, DUE_KEY, String(now + IDLE_MS))
      await ensurePass(deps, now)
    },
  }
}

function forget(deps: ModuleDeps): Op {
  return defineOp({
    name: "memory.forget",
    args: obj({ query: str({ minLength: 1, maxLength: 200 }) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const tokens = tokenize(args.query)
      const retired =
        tokens.length === 0
          ? await deps.db.runCounted(
              "UPDATE notes SET retired_by = ? WHERE retired_by IS NULL AND instr(lower(text), lower(?)) > 0",
              OWNER_RETIREMENT,
              args.query,
            )
          : await deps.db.runCounted(
              `UPDATE notes SET retired_by = ? WHERE retired_by IS NULL AND id IN (
                 SELECT n.id FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
                 WHERE notes_fts MATCH ? AND n.retired_by IS NULL
               )`,
              OWNER_RETIREMENT,
              ftsAll(tokens),
            )
      await requestPass(deps, Date.now())
      return { retired }
    },
  })
}

function list(deps: ModuleDeps): Op {
  return defineOp({
    name: "memory.list",
    args: obj({ scope: opt(str({ pattern: SCOPE_PATTERN })) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const notes =
        args.scope === undefined
          ? await deps.db.all<Note>(
              "SELECT id, scope, text, at FROM notes WHERE retired_by IS NULL ORDER BY id DESC LIMIT ?",
              LIST_LIMIT,
            )
          : await deps.db.all<Note>(
              "SELECT id, scope, text, at FROM notes WHERE retired_by IS NULL AND scope = ? ORDER BY id DESC LIMIT ?",
              args.scope,
              LIST_LIMIT,
            )
      return { notes }
    },
  })
}

function profile(deps: ModuleDeps): Op {
  return defineOp({
    name: "memory.profile",
    args: obj({}),
    actors: ["owner"],
    run: async () => ({ profile_md: await readProfile(deps.db) }),
  })
}

export async function searchNotes(
  db: SqliteExecutor,
  query: string,
  scopes: readonly string[],
  now: number,
  limit = RECALL_LIMIT,
): Promise<Note[]> {
  if (scopes.length === 0) return []
  const placeholders = scopes.map(() => "?").join(", ")
  const tokens = tokenize(query)
  if (tokens.length === 0)
    return db.all<Note>(
      `SELECT id, scope, text, at FROM notes
       WHERE retired_by IS NULL AND instr(lower(text), lower(?)) > 0 AND scope IN (${placeholders})
       ORDER BY at DESC LIMIT ?`,
      query,
      ...scopes,
      limit,
    )
  return db.all<Note>(
    `SELECT n.id, n.scope, n.text, n.at FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
     WHERE notes_fts MATCH ? AND n.retired_by IS NULL AND n.scope IN (${placeholders})
     ORDER BY bm25(notes_fts) + (? - n.at) / 86400000.0 * 0.05 ASC LIMIT ?`,
    ftsAny(tokens),
    ...scopes,
    now,
    limit,
  )
}

function tokenize(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((token) => token.length > 0)
}

const quoted = (tokens: readonly string[]): string[] => tokens.map((token) => `"${token.replaceAll('"', "")}"`)

const ftsAny = (tokens: readonly string[]): string => quoted(tokens).join(" OR ")

const ftsAll = (tokens: readonly string[]): string => quoted(tokens).join(" ")
