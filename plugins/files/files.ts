import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import {
  AgentDoc,
  type ConversationId,
  defineExtension,
  type Extension,
  hook,
  ROOT_CONVERSATION_ID,
  ToolTask,
  type ToolHooks,
} from "@earendil-works/pi-durable"
import { compile, int, obj, opt, str } from "@earendil-works/pi-schema"
import type { FileEntry, FilesService } from "../../src/contracts/files.ts"
import type { Env } from "../../src/env.ts"
import type { Route } from "../../src/module.ts"
import { type Actor, defineOp, type Op, OpRejected } from "../../src/ops.ts"
import { blobKey, FileIndex, type FileRow, normalizePath, putFile, R2Env, resolvePath } from "../../src/r2env.ts"

const MAX_COMMIT_BYTES = 4096
const SWEEP_EVERY_MS = 7 * 24 * 60 * 60_000
const ORPHAN_GRACE_MS = 24 * 60 * 60_000
const SWEEP_KEY = "files:sweep_at"

const Commit = obj({
  path: str({ minLength: 1 }),
  r2Key: str({ minLength: 1 }),
  size: int({ minimum: 0 }),
  type: str({ minLength: 1 }),
  sha256: str({ minLength: 64, maxLength: 64 }),
})
const parseCommit = compile(Commit)

export type WriteScope = (write: { readonly actor: Actor; readonly path: string }) => string | undefined

export type FilesPort = {
  readonly state: DurableObjectState
  readonly env: Env
  readonly db: SqliteDatabase
}

export type SweepPort = Pick<FilesPort, "state" | "env" | "db">

export type FilesPlugin = {
  readonly service: FilesService
  readonly scope: Extension
  readonly ops: readonly Op[]
  readonly commit: Route
  start(): Promise<void>
  due(): Promise<number | undefined>
  fire(now: number): Promise<void>
}

const coordinatorOnly: WriteScope = ({ actor, path }) => {
  if (path !== "/me" && !path.startsWith("/me/")) return undefined
  if (actor.kind === "owner") return undefined
  if (actor.kind === "agent" && actor.conversationId === ROOT_CONVERSATION_ID) return undefined
  return "only the coordinator may write /me"
}

const agentActor = (conversationId: ConversationId): Actor => ({ kind: "agent", conversationId })

function scoped(scope: WriteScope): Extension {
  const beforeTool: ToolHooks["beforeTool"] = async (call, api, context) => {
    if (call.name !== "write" && call.name !== "edit") return undefined
    const path = call.arguments.path
    if (typeof path !== "string") return undefined
    const cwd = (await api.snapshot(AgentDoc, api.conversationId, context))?.cwd ?? "/"
    const absolute = resolvePath(cwd, path)
    if (absolute === undefined) return { block: "path escapes the files root" }
    const blocked = scope({ actor: agentActor(api.conversationId), path: absolute })
    return blocked === undefined ? undefined : { block: blocked }
  }
  return defineExtension({
    name: "xin.files.scope",
    hooks: [hook(ToolTask, { beforeTool })],
  })
}

function entryOf(row: FileRow): FileEntry {
  return {
    path: row.path,
    size: row.size,
    type: row.type,
    sha256: row.sha256,
    project: row.project,
    updated_at: row.updated_at,
  }
}

function rootedPath(path: string): string {
  const normalized = normalizePath("/", path)
  if (normalized === undefined) throw new Error("path escapes the files root")
  return normalized
}

export function create(deps: FilesPort, scope: WriteScope = coordinatorOnly): FilesPlugin {
  const dirs = new Set<string>(["/"])
  const index = new FileIndex(deps.db)
  const envFor = (cwd: string | undefined): R2Env => new R2Env(deps.env.FILES, deps.db, { cwd: cwd ?? "/", dirs })

  const files: FilesService = {
    env: (target) => envFor(target.cwd),
    list: async (prefix) => (await index.under(prefix ?? "/")).map(entryOf),
    read: async (path) => {
      const row = await index.row(rootedPath(path))
      if (row === undefined) return undefined
      const object = await deps.env.FILES.get(row.r2_key)
      return object === null ? undefined : object.text()
    },
    stat: async (path) => {
      const row = await index.row(rootedPath(path))
      return row === undefined ? undefined : entryOf(row)
    },
    write: async (path, text) =>
      entryOf(await putFile(deps.env.FILES, index, { path: rootedPath(path), content: text })),
    remove: async (path) => index.drop(rootedPath(path)),
  }

  const list = defineOp({
    name: "file.list",
    args: obj({ prefix: opt(str()) }),
    actors: ["owner", "agent", "plugin"],
    run: async (_api, { prefix }) => {
      const base = normalizePath("/", prefix ?? "/")
      if (base === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      return files.list(base === "/" ? "/" : `${base}/`)
    },
  })

  const remove = defineOp({
    name: "file.delete",
    args: obj({ path: str({ minLength: 1 }) }),
    actors: ["owner", "agent", "plugin"],
    run: async ({ actor }, { path }) => {
      const target = normalizePath("/", path)
      if (target === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const blocked = scope({ actor, path: target })
      if (blocked !== undefined) throw new OpRejected("forbidden", blocked)
      return { deleted: await files.remove(target) }
    },
  })

  const put = defineOp({
    name: "file.put",
    args: obj({ path: str({ minLength: 1 }), text: str() }),
    actors: ["owner", "agent", "plugin"],
    run: async ({ actor }, { path, text }) => {
      const target = normalizePath("/", path)
      if (target === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const blocked = scope({ actor, path: target })
      if (blocked !== undefined) throw new OpRejected("forbidden", blocked)
      return files.write(target, text)
    },
  })

  const commit = async (request: Request): Promise<Response> => {
    const text = await request.text()
    if (text.length > MAX_COMMIT_BYTES) return Response.json({ error: "commit carries metadata only" }, { status: 413 })
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return Response.json({ error: "commit is not JSON" }, { status: 400 })
    }
    if (!parseCommit.check(body)) return Response.json({ error: "bad commit" }, { status: 400 })
    if (body.r2Key !== blobKey(body.sha256))
      return Response.json({ error: "r2Key must be the content address" }, { status: 400 })
    const path = normalizePath("/", body.path)
    if (path === undefined) return Response.json({ error: "path escapes the files root" }, { status: 400 })
    const head = await deps.env.FILES.head(body.r2Key)
    if (head === null || head.size !== body.size)
      return Response.json({ error: "bytes are not in R2" }, { status: 409 })
    await index.upsert({
      path,
      r2Key: body.r2Key,
      size: body.size,
      type: body.type,
      sha256: body.sha256,
    })
    return Response.json({ ok: true })
  }

  return {
    service: files,
    scope: scoped(scope),
    ops: [list, remove, put],
    commit,
    start: () =>
      deps.db.run(
        "INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)",
        SWEEP_KEY,
        String(Date.now() + SWEEP_EVERY_MS),
      ),
    due: () => nextSweep(deps),
    fire: async (now) => {
      const at = await nextSweep(deps)
      if (at === undefined || at > now) return
      await sweep(deps, now)
      await deps.db.run(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        SWEEP_KEY,
        String(now + SWEEP_EVERY_MS),
      )
    },
  }
}

async function nextSweep(deps: Pick<FilesPort, "db">): Promise<number | undefined> {
  const row = await deps.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", SWEEP_KEY)
  return row === undefined ? undefined : Number(row.value)
}

export async function sweep(deps: SweepPort, now: number): Promise<number> {
  const index = new FileIndex(deps.db)
  let deleted = 0
  for await (const object of objects(deps.env.FILES, "b/")) {
    if (now - object.uploaded.getTime() < ORPHAN_GRACE_MS) continue
    const removed = await deps.state.blockConcurrencyWhile(async () => {
      const head = await deps.env.FILES.head(object.key)
      if (head === null) return false
      if (now - head.uploaded.getTime() < ORPHAN_GRACE_MS) return false
      if (await index.referenced(head.key)) return false
      await deps.env.FILES.delete(head.key)
      return true
    })
    if (removed) deleted += 1
  }
  for await (const object of objects(deps.env.FILES, "tmp/")) {
    if (now - object.uploaded.getTime() < ORPHAN_GRACE_MS) continue
    await deps.env.FILES.delete(object.key)
    deleted += 1
  }
  return deleted
}

async function* objects(bucket: R2Bucket, prefix: string): AsyncGenerator<R2Object> {
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) })
    for (const object of page.objects) yield object
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
}
