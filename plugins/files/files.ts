import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import {
  AgentDoc,
  type ConversationId,
  defineExtension,
  type DocumentReader,
  type Extension,
  hook,
  ROOT_CONVERSATION_ID,
  ToolTask,
  type ToolHooks,
} from "@earendil-works/pi-durable"
import { compile, int, obj, opt, str } from "@earendil-works/pi-schema"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { FileEntry, FilesService } from "../../src/contracts/files.ts"
import type { Env } from "../../src/env.ts"
import type { Route } from "../../src/module.ts"
import { type Actor, defineOp, type Op, OpRejected } from "../../src/ops.ts"
import { blobKey, FileIndex, type FileRow, normalizePath, putFile, R2Env, resolvePath } from "../../src/r2env.ts"

const context = BACKGROUND_CONTEXT

const MAX_COMMIT_BYTES = 4096
const SWEEP_EVERY_MS = 7 * 24 * 60 * 60_000
const ORPHAN_GRACE_MS = 24 * 60 * 60_000
const SWEEP_KEY = "files:sweep_at"
/** Types the client can show as text; anything else comes back with `text: null`. */
const PREVIEWABLE = /^(text\/|application\/(json|xml|.*\+json|.*\+xml)|image\/svg\+xml)/

const Commit = obj({
  path: str({ minLength: 1 }),
  r2Key: str({ minLength: 1 }),
  size: int({ minimum: 0 }),
  type: str({ minLength: 1 }),
  sha256: str({ minLength: 64, maxLength: 64 }),
})
const parseCommit = compile(Commit)

export type WriteScope = (write: {
  readonly actor: Actor
  readonly path: string
  readonly read: DocumentReader
}) => string | undefined | Promise<string | undefined>

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

const isMe = (path: string): boolean => path === "/me" || path.startsWith("/me/")

const coordinatorOnly: WriteScope = ({ actor, path }) => {
  if (!isMe(path)) return undefined
  if (actor.kind === "owner") return undefined
  if (actor.kind === "agent" && actor.conversationId === ROOT_CONVERSATION_ID) return undefined
  return "only the coordinator may write /me"
}

/**
 * A thread writes only under its own project's folder. A project coordinator, the root chat and the owner
 * keep the older rule: everything except `/me` is open to them.
 */
const projectScoped: WriteScope = async ({ actor, path, read }) => {
  const blocked = coordinatorOnly({ actor, path, read })
  if (blocked !== undefined) return blocked
  if (actor.kind !== "agent" || actor.conversationId === ROOT_CONVERSATION_ID) return undefined
  const thread = await read.snapshot(ThreadDoc, actor.conversationId, context)
  if (thread === undefined) return undefined
  const workspace = await read.snapshot(WorkspaceDoc, context)
  const project = workspace?.projects[thread.projectId]
  if (project === undefined) return `thread ${actor.conversationId} has no project`
  const prefix = `/projects/${project.slug}/`
  return path.startsWith(prefix) ? undefined : `a thread writes only under ${prefix}`
}

const agentActor = (conversationId: ConversationId): Actor => ({ kind: "agent", conversationId })

function scoped(scope: WriteScope): Extension {
  const beforeTool: ToolHooks["beforeTool"] = async (call, api, toolContext) => {
    if (call.name !== "write" && call.name !== "edit") return undefined
    const path = call.arguments.path
    if (typeof path !== "string") return undefined
    const cwd = (await api.snapshot(AgentDoc, api.conversationId, toolContext))?.cwd ?? "/"
    const absolute = resolvePath(cwd, path)
    if (absolute === undefined) return { block: "path escapes the files root" }
    const blocked = await scope({ actor: agentActor(api.conversationId), path: absolute, read: api })
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

export function create(deps: FilesPort, scope: WriteScope = projectScoped): FilesPlugin {
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
    readBytes: async (path) => {
      const row = await index.row(rootedPath(path))
      if (row === undefined) return undefined
      const object = await deps.env.FILES.get(row.r2_key)
      return object === null ? undefined : new Uint8Array(await object.arrayBuffer())
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
    run: async (api, { prefix }) => {
      const base = normalizePath("/", prefix ?? "/")
      if (base === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const target = base === "/" ? "/" : `${base}/`
      const blocked = await scope({ actor: api.actor, path: target, read: api.harness })
      if (blocked !== undefined) throw new OpRejected("forbidden", blocked)
      return files.list(target)
    },
  })

  const read = defineOp({
    name: "file.read",
    args: obj({ path: str({ minLength: 1 }) }),
    actors: ["owner", "agent", "plugin"],
    run: async (api, { path }) => {
      const target = normalizePath("/", path)
      if (target === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const blocked = await scope({ actor: api.actor, path: target, read: api.harness })
      if (blocked !== undefined) throw new OpRejected("forbidden", blocked)
      const entry = await files.stat(target)
      if (entry === undefined) throw new OpRejected("bad_args", `no file ${target}`)
      const text = PREVIEWABLE.test(entry.type) ? await files.read(target) : undefined
      const revisions = await index.revisions(target)
      return { ...entry, text: text ?? null, versions: revisions.length + 1 }
    },
  })

  const revision = defineOp({
    name: "file.revision",
    args: obj({ path: str({ minLength: 1 }), sha256: str({ minLength: 64, maxLength: 64 }) }),
    actors: ["owner", "agent", "plugin"],
    run: async (api, { path, sha256 }) => {
      const target = normalizePath("/", path)
      if (target === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const blocked = await scope({ actor: api.actor, path: target, read: api.harness })
      if (blocked !== undefined) throw new OpRejected("forbidden", blocked)
      const found = (await index.revisions(target)).find((candidate) => candidate.sha256 === sha256)
      if (found === undefined) throw new OpRejected("bad_args", `no revision of ${target}`)
      const object = await deps.env.FILES.get(blobKey(sha256))
      const text = object === null || !PREVIEWABLE.test(found.type) ? null : await object.text()
      return { path: target, ...found, text }
    },
  })

  const revisions = defineOp({
    name: "file.revisions",
    args: obj({ path: str({ minLength: 1 }) }),
    actors: ["owner", "agent", "plugin"],
    run: async (api, { path }) => {
      const target = normalizePath("/", path)
      if (target === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const blocked = await scope({ actor: api.actor, path: target, read: api.harness })
      if (blocked !== undefined) throw new OpRejected("forbidden", blocked)
      return { path: target, revisions: await index.revisions(target) }
    },
  })

  const remove = defineOp({
    name: "file.delete",
    args: obj({ path: str({ minLength: 1 }) }),
    actors: ["owner", "agent", "plugin"],
    run: async (api, { path }) => {
      const target = normalizePath("/", path)
      if (target === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const blocked = await scope({ actor: api.actor, path: target, read: api.harness })
      if (blocked !== undefined) throw new OpRejected("forbidden", blocked)
      return { deleted: await files.remove(target) }
    },
  })

  const put = defineOp({
    name: "file.put",
    args: obj({ path: str({ minLength: 1 }), text: str() }),
    actors: ["owner", "agent", "plugin"],
    run: async (api, { path, text }) => {
      const target = normalizePath("/", path)
      if (target === undefined) throw new OpRejected("bad_args", "path escapes the files root")
      const blocked = await scope({ actor: api.actor, path: target, read: api.harness })
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
    ops: [list, remove, put, read, revision, revisions],
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
