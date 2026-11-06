import type { SqliteExecutor } from "@earendil-works/chord/sqlite"
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
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
import { isScope, refusal, SCOPE_PATTERN } from "./dreamprompt.ts"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { defineOp, type Op } from "../../src/ops.ts"
import { projectInScope } from "../workspace/threaddoc.ts"

const RECALL_LIMIT = 20
const LIST_LIMIT = 100
const OWNER_RETIREMENT = 0

export type Note = {
  readonly id: number
  readonly scope: string
  readonly text: string
  readonly at: number
}

export function create(deps: ModuleDeps): HostModule {
  return {
    extensions: [
      defineExtension({
        name: "memory",
        tools: [remember(deps), recall(deps)],
        sections: [profileSection(deps)],
        tasks: [dreamerTask(deps)],
      }),
    ],
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

function remember(deps: ModuleDeps) {
  return defineTool({
    name: "remember",
    description: "Save one durable fact about the owner or a project, so later turns can recall it.",
    parameters: obj({
      text: str({ minLength: 1, maxLength: 2000 }),
      scope: opt(str({ pattern: SCOPE_PATTERN })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const text = args.text.trim()
      if (text.length === 0) return refused("empty text")
      const project = await projectInScope(api, api.conversationId)
      const own = project === undefined ? undefined : `project:${project.projectId}`
      const scope = args.scope ?? own ?? "me"
      if (!isScope(scope)) return refused(`unknown scope ${scope}`)
      if (scope !== "me" && scope !== own) return refused(`scope ${scope} belongs to another conversation`)
      const denied = refusal(text)
      if (denied !== undefined) return refused(denied)
      const now = Date.now()
      const inserted = await appendNote(deps.db, {
        text,
        scope,
        source: "remember",
        originTask: String(api.taskId),
        at: now,
      })
      await requestPass(deps, now + IDLE_MS)
      return said(inserted ? `Remembered (${scope}).` : `Already remembered (${scope}).`)
    },
  })
}

function recall(deps: ModuleDeps) {
  return defineTool({
    name: "recall",
    description: "Search saved notes by keyword, newest and most relevant first.",
    parameters: obj({
      q: str({ minLength: 1, maxLength: 200 }),
      scope: opt(str({ pattern: SCOPE_PATTERN })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const project = await projectInScope(api, api.conversationId)
      const allowed = project === undefined ? ["me"] : ["me", `project:${project.projectId}`]
      if (args.scope !== undefined) {
        if (!isScope(args.scope)) return notRecalled(`unknown scope ${args.scope}`)
        if (!allowed.includes(args.scope)) return notRecalled(`scope ${args.scope} belongs to another conversation`)
      }
      const notes = await searchNotes(deps.db, args.q, args.scope === undefined ? allowed : [args.scope], Date.now())
      if (notes.length === 0) return said("No matching notes.")
      return said(notes.map((note) => `- [${note.scope}] ${note.text}`).join("\n"))
    },
  })
}

function profileSection(deps: ModuleDeps) {
  return section("profile", async () => {
    const text = await readProfile(deps.db)
    return text.trim().length === 0 ? undefined : text
  })
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

function said(text: string) {
  return { output: [{ type: "text" as const, text }] }
}

function refused(reason: string) {
  return { output: [{ type: "text" as const, text: `Not saved: ${reason}.` }], isError: true }
}

function notRecalled(reason: string) {
  return { output: [{ type: "text" as const, text: `Cannot recall: ${reason}.` }], isError: true }
}
