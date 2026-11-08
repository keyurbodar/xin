import type { SqliteExecutor } from "@earendil-works/chord/sqlite"
import { defineExtension, type Extension } from "@earendil-works/pi-durable"
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema"
import type { ListedNote, MemoryService, Note } from "../../src/contracts/memory.ts"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"
import {
  appendNote,
  CURSOR_KEY,
  deleteKv,
  DUE_KEY,
  dreamerTask,
  ensurePass,
  IDLE_MS,
  type MemoryPorts,
  PROFILE_KEY,
  readNumber,
  readProfile,
  requestPass,
  writeKv,
} from "./dreamer.ts"
import { SCOPE_PATTERN } from "./dreamprompt.ts"

const RECALL_LIMIT = 20
const LIST_LIMIT = 100
const PROFILE_LIMIT = 20_000
const OWNER_RETIREMENT = 0

export type MemoryPlugin = {
  readonly service: MemoryService
  readonly extension: Extension
  readonly ops: readonly Op[]
  start(): Promise<void>
  due(): Promise<number | undefined>
  fire(now: number): Promise<void>
}

export function create(ports: MemoryPorts): MemoryPlugin {
  const memory: MemoryService = {
    remember: async (draft) => {
      const inserted = await appendNote(ports.db, draft)
      await requestPass(ports, draft.at + IDLE_MS)
      return inserted
    },
    search: (query, scopes, now, limit) => searchNotes(ports.db, query, scopes, now, limit),
    profile: () => readProfile(ports.db),
  }

  return {
    service: memory,
    extension: defineExtension({ name: "memory", tasks: [dreamerTask(ports)] }),
    ops: [forget(ports), list(ports), add(ports), pin(ports), edit(ports), profile(ports), writeProfile(ports)],
    start: async () => {
      const cursor = (await readNumber(ports.db, CURSOR_KEY)) ?? 0
      const newest = await ports.db.get<{ at: number }>(
        "SELECT at FROM notes WHERE id > ? AND retired_by IS NULL AND source != 'dreamer' ORDER BY at DESC LIMIT 1",
        cursor,
      )
      const due = await readNumber(ports.db, DUE_KEY)
      const idle = newest === undefined ? undefined : newest.at + IDLE_MS
      const at = idle === undefined ? due : due === undefined ? idle : Math.min(idle, due)
      if (at !== undefined) await ensurePass(ports, at)
    },
    due: () => readNumber(ports.db, DUE_KEY),
    fire: async (now) => {
      const due = await readNumber(ports.db, DUE_KEY)
      if (due === undefined || due > now) return
      await writeKv(ports.db, DUE_KEY, String(now + IDLE_MS))
      await ensurePass(ports, now)
    },
  }
}

function forget(ports: MemoryPorts): Op {
  return defineOp({
    name: "memory.forget",
    args: obj({ query: opt(str({ minLength: 1, maxLength: 200 })), id: opt(int({ minimum: 1 })) }),
    actors: ["owner"],
    run: async (_api, args) => {
      if ((args.query === undefined) === (args.id === undefined))
        throw new OpRejected("bad_args", "give one note id or one query")
      const { id, query } = args
      if (id !== undefined) {
        const retired = await ports.db.runCounted(
          "UPDATE notes SET retired_by = ? WHERE id = ? AND retired_by IS NULL",
          OWNER_RETIREMENT,
          id,
        )
        await requestPass(ports, Date.now())
        return { retired }
      }
      if (query === undefined) throw new OpRejected("bad_args", "give one note id or one query")
      const tokens = tokenize(query)
      const retired =
        tokens.length === 0
          ? await ports.db.runCounted(
              "UPDATE notes SET retired_by = ? WHERE retired_by IS NULL AND instr(lower(text), lower(?)) > 0",
              OWNER_RETIREMENT,
              query,
            )
          : await ports.db.runCounted(
              `UPDATE notes SET retired_by = ? WHERE retired_by IS NULL AND id IN (
                 SELECT n.id FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
                 WHERE notes_fts MATCH ? AND n.retired_by IS NULL
               )`,
              OWNER_RETIREMENT,
              ftsAll(tokens),
            )
      await requestPass(ports, Date.now())
      return { retired }
    },
  })
}

type NoteRow = {
  readonly id: number
  readonly scope: string
  readonly text: string
  readonly at: number
  readonly source: string
  readonly pinned: number
}

const noteOf = (row: NoteRow): ListedNote => ({
  id: row.id,
  scope: row.scope,
  text: row.text,
  at: row.at,
  source: row.source,
  pinned: row.pinned === 1,
})

function add(ports: MemoryPorts): Op {
  return defineOp({
    name: "memory.add",
    args: obj({ text: str({ minLength: 1, maxLength: 2000 }), scope: opt(str({ pattern: SCOPE_PATTERN })) }),
    actors: ["owner"],
    run: async (api, args) => {
      const text = args.text.trim()
      if (text === "") throw new OpRejected("bad_args", "a note needs text")
      const scope = args.scope ?? "me"
      await appendNote(ports.db, {
        text,
        scope,
        source: "remember",
        originTask: `owner:${api.commandId}`,
        at: Date.now(),
      })
      await requestPass(ports, Date.now())
      return { text, scope }
    },
  })
}

function pin(ports: MemoryPorts): Op {
  return defineOp({
    name: "memory.pin",
    args: obj({ id: int({ minimum: 1 }), pinned: bool() }),
    actors: ["owner"],
    run: async (_api, args) => {
      const changed = await ports.db.runCounted(
        "UPDATE notes SET pinned = ? WHERE id = ? AND retired_by IS NULL",
        args.pinned ? 1 : 0,
        args.id,
      )
      if (changed === 0) throw new OpRejected("bad_args", `no note ${args.id}`)
      return { id: args.id, pinned: args.pinned }
    },
  })
}

function edit(ports: MemoryPorts): Op {
  return defineOp({
    name: "memory.edit",
    args: obj({ id: int({ minimum: 1 }), text: str({ minLength: 1, maxLength: 2000 }) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const text = args.text.trim()
      if (text === "") throw new OpRejected("bad_args", "a note needs text")
      const changed = await ports.db.runCounted(
        "UPDATE notes SET text = ?, dirty = 1 WHERE id = ? AND retired_by IS NULL",
        text,
        args.id,
      )
      if (changed === 0) throw new OpRejected("bad_args", `no note ${args.id}`)
      await requestPass(ports, Date.now())
      return { id: args.id, text }
    },
  })
}

function list(ports: MemoryPorts): Op {
  return defineOp({
    name: "memory.list",
    args: obj({ scope: opt(str({ pattern: SCOPE_PATTERN })) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const rows =
        args.scope === undefined
          ? await ports.db.all<NoteRow>(
              "SELECT id, scope, text, at, source, pinned FROM notes WHERE retired_by IS NULL ORDER BY pinned DESC, id DESC LIMIT ?",
              LIST_LIMIT,
            )
          : await ports.db.all<NoteRow>(
              "SELECT id, scope, text, at, source, pinned FROM notes WHERE retired_by IS NULL AND scope = ? ORDER BY pinned DESC, id DESC LIMIT ?",
              args.scope,
              LIST_LIMIT,
            )
      return { notes: rows.map(noteOf) }
    },
  })
}

function profile(ports: MemoryPorts): Op {
  return defineOp({
    name: "memory.profile",
    args: obj({}),
    actors: ["owner"],
    run: async () => ({ profile_md: await readProfile(ports.db) }),
  })
}

function writeProfile(ports: MemoryPorts): Op {
  return defineOp({
    name: "memory.profile.write",
    args: obj({ markdown: str({ maxLength: PROFILE_LIMIT }) }),
    actors: ["owner"],
    run: async (_api, args) => {
      if (args.markdown.trim() === "") await deleteKv(ports.db, PROFILE_KEY)
      else await writeKv(ports.db, PROFILE_KEY, args.markdown)
      return { profile_md: await readProfile(ports.db) }
    },
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
