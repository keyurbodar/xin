import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { type ConversationId, defineExtension, type Extension, type Harness, section } from "@earendil-works/pi-durable"
import { compile, int, lit, obj, opt, type Static, str, union } from "@earendil-works/pi-schema"
import {
  DRIVE_SCOPE_ID,
  type DriveScope,
  type DriveScopeSource,
  type DriveService,
  type DriveSkillFile,
} from "../../src/contracts/drive.ts"
import type { FileEntry, FilesService } from "../../src/contracts/files.ts"
import { projectByRef, scopeOf } from "../../src/contracts/scope.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import { defineOp, type Op, OpRejected } from "../../src/ops.ts"
import { StaleWrite } from "../../src/r2env.ts"
import { createShares } from "./shares.ts"

const context = BACKGROUND_CONTEXT

const INSTRUCTIONS = "AGENTS.md"
const SKILL_FILE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/
const MAX_INSTRUCTIONS_CHARS = 20_000
/** Starts the bad_args message of a write whose `base` is no longer current; clients match on it to offer reload or overwrite. */
export const STALE_BASE = "stale base"
const PREVIEWABLE = /^(text\/|application\/(json|xml|.*\+json|.*\+xml)|image\/svg\+xml)/

export const ScopeSchema = union([
  obj({ kind: lit("user") }),
  obj({ kind: lit("project"), id: str({ minLength: 1, maxLength: 200 }) }),
  obj({ kind: lit("captain"), id: str({ pattern: DRIVE_SCOPE_ID }) }),
  obj({ kind: lit("automation"), id: str({ pattern: DRIVE_SCOPE_ID }) }),
])
const parseScope = compile(ScopeSchema)
type ScopeArg = Static<typeof ScopeSchema>
const Path = str({ minLength: 1, maxLength: 1_000 })
const Sha = str({ minLength: 64, maxLength: 64 })

export type DrivePort = {
  readonly db: SqliteDatabase
  readonly files: FilesService
  readonly harness: Harness
}

type Reserved = {
  readonly instructions: string | undefined
  readonly skills: readonly { readonly name: string; readonly markdown: string }[]
}

type Mounted = { readonly scope: DriveScope; readonly root: string; readonly label: string }

export type DrivePlugin = {
  readonly service: DriveService
  readonly ops: readonly Op[]
  readonly extension: Extension
  /** A thread may use the roots of its Captain and automation scopes; its project folder is already open to it. */
  grant(conversationId: ConversationId, path: string): Promise<boolean>
  changed(path: string): Promise<void>
}

const labelOf = (scope: DriveScope, root: string): string =>
  scope.kind === "user" ? "user" : `${scope.kind} ${root.split("/").at(-2) ?? ""}`

/** Whether a change at `path` (a prefix when it ends in `/`) can touch the reserved files under `root`. */
function touchesReserved(root: string, path: string): boolean {
  if (path.endsWith("/")) return path.startsWith(root) || root.startsWith(path)
  return path === `${root}${INSTRUCTIONS}` || path.startsWith(`${root}skills/`)
}

/** A path inside a scope, as the client and the agent write it: relative, or absolute from the scope's root. */
function inside(root: string, path: string): string {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) throw new OpRejected("bad_args", "path escapes the scope")
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) throw new OpRejected("bad_args", "path names the scope's root")
  return `${root}${parts.join("/")}`
}

const relative = (root: string, entry: FileEntry): FileEntry => ({ ...entry, path: entry.path.slice(root.length) })

export function create(deps: DrivePort): DrivePlugin {
  const sources = new Set<DriveScopeSource>()
  const reserved = new Map<string, Promise<Reserved>>()

  const rootOf = async (scope: DriveScope): Promise<string | undefined> => {
    switch (scope.kind) {
      case "user":
        return "/me/"
      case "project": {
        const found = await projectByRef(deps.harness, scope.id)
        return found === undefined ? undefined : `/projects/${found.project.slug}/`
      }
      case "captain":
        return `/captains/${scope.id}/`
      case "automation":
        return `/automations/${scope.id}/`
      default: {
        const _exhaustive: never = scope
        return _exhaustive
      }
    }
  }

  const mount = async (scope: DriveScope): Promise<Mounted | undefined> => {
    const root = await rootOf(scope)
    return root === undefined ? undefined : { scope, root, label: labelOf(scope, root) }
  }

  const requireRoot = async (scope: ScopeArg): Promise<string> => {
    const root = await rootOf(scope)
    if (root === undefined) throw new OpRejected("bad_args", `no ${scope.kind} ${"id" in scope ? scope.id : ""}`)
    return root
  }

  const scopesOf = async (conversationId: ConversationId): Promise<readonly Mounted[]> => {
    const scopes: DriveScope[] = [{ kind: "user" }]
    const own = await scopeOf(deps.harness, conversationId)
    if (own !== undefined && own.kind !== "puck") scopes.push({ kind: "project", id: own.projectId })
    for (const source of sources)
      for (const scope of await source(conversationId)) if (parseScope.check(scope)) scopes.push(scope)
    const mounted: Mounted[] = []
    for (const scope of scopes) {
      const found = await mount(scope)
      if (found !== undefined && !mounted.some((other) => other.root === found.root)) mounted.push(found)
    }
    return mounted
  }

  const load = async (root: string): Promise<Reserved> => {
    const instructions = await deps.files.read(`${root}${INSTRUCTIONS}`)
    const skills: { name: string; markdown: string }[] = []
    for (const entry of await deps.files.list(`${root}skills/`)) {
      const name = SKILL_FILE.exec(entry.path.slice(root.length))?.[1]
      if (name === undefined) continue
      const markdown = await deps.files.read(entry.path)
      if (markdown !== undefined) skills.push({ name, markdown })
    }
    return { instructions, skills }
  }

  const reservedOf = (root: string): Promise<Reserved> => {
    const cached = reserved.get(root)
    if (cached !== undefined) return cached
    const loading = load(root)
    reserved.set(root, loading)
    loading.catch(() => reserved.delete(root))
    return loading
  }

  const shares = createShares(deps)

  const changed = async (path: string): Promise<void> => {
    for (const root of reserved.keys()) if (touchesReserved(root, path)) reserved.delete(root)
    await shares.changed(path)
  }

  const service: DriveService = {
    attach: (source) => {
      sources.add(source)
      return () => sources.delete(source)
    },
    skills: async (conversationId) => {
      const scopes =
        conversationId === undefined
          ? [{ scope: { kind: "user" } as const, root: "/me/" }]
          : await scopesOf(conversationId)
      const out: DriveSkillFile[] = []
      for (const { scope, root } of scopes)
        for (const skill of (await reservedOf(root)).skills) out.push({ scope, ...skill })
      return out
    },
    write: async (scope, path, text) => deps.files.write(inside(await requireRoot(scope), path), text),
    remove: async (scope, path) => deps.files.remove(inside(await requireRoot(scope), path)),
  }

  const instructionsSection = section("drive", async (input) => {
    const scopes = await scopesOf(input.conversationId)
    const own = await scopeOf(deps.harness, input.conversationId)
    const extra = scopes.filter((mounted) =>
      mounted.scope.kind === "user" ? own?.kind === "puck" : mounted.scope.kind !== "project",
    )
    const lines =
      extra.length === 0
        ? []
        : [
            "Drive keeps files across conversations. Use the file tools under your scopes' folders:",
            ...extra.map((mounted) => `- ${mounted.label}: ${mounted.root}`),
          ]
    for (const mounted of scopes) {
      const text = (await reservedOf(mounted.root)).instructions?.trim()
      if (text === undefined || text === "") continue
      const clipped = text.length > MAX_INSTRUCTIONS_CHARS ? `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n[cut]` : text
      if (lines.length > 0) lines.push("")
      lines.push(
        `<instructions scope="${mounted.label}" path="${mounted.root}${INSTRUCTIONS}">`,
        clipped,
        "</instructions>",
      )
    }
    return lines.length === 0 ? undefined : lines.join("\n")
  })

  const textOf = async (sha256: string, type: string): Promise<string | null> =>
    PREVIEWABLE.test(type) ? deps.files.textOf(sha256) : null

  const list = defineOp({
    name: "drive.list",
    read: true,
    args: obj({ scope: ScopeSchema, prefix: opt(str({ maxLength: 1_000 })) }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, prefix }) => {
      const root = await requireRoot(scope)
      const base = prefix === undefined || prefix.replaceAll("/", "") === "" ? root : `${inside(root, prefix)}/`
      const files = await deps.files.list(base)
      const shared: Record<string, string> = {}
      for (const entry of files) {
        const id = await shares.idOf(entry.path)
        if (id !== undefined) shared[entry.path.slice(root.length)] = id
      }
      return { root, files: files.map((entry) => relative(root, entry)), shares: shared }
    },
  })

  const read = defineOp({
    name: "drive.read",
    read: true,
    args: obj({ scope: ScopeSchema, path: Path, sha256: opt(Sha) }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, path, sha256 }) => {
      const root = await requireRoot(scope)
      const target = inside(root, path)
      const entry = await deps.files.stat(target)
      if (entry === undefined) throw new OpRejected("bad_args", `no file ${path}`)
      if (sha256 === undefined || sha256 === entry.sha256)
        return { ...relative(root, entry), text: await textOf(entry.sha256, entry.type) }
      const version = (await deps.files.revisions(target)).find((candidate) => candidate.sha256 === sha256)
      if (version === undefined) throw new OpRejected("bad_args", `no version ${sha256} of ${path}`)
      return {
        path: entry.path.slice(root.length),
        ...version,
        updated_at: version.at,
        text: await textOf(version.sha256, version.type),
      }
    },
  })

  const write = defineOp({
    name: "drive.write",
    args: obj({ scope: ScopeSchema, path: Path, text: str({ maxLength: 4 * 1024 * 1024 }), base: opt(Sha) }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, path, text, base }) => {
      const root = await requireRoot(scope)
      try {
        return relative(root, await deps.files.write(inside(root, path), text, base))
      } catch (problem) {
        if (!(problem instanceof StaleWrite)) throw problem
        throw new OpRejected(
          "bad_args",
          `${STALE_BASE}: ${path} changed since ${base} (now ${problem.current ?? "deleted"})`,
        )
      }
    },
  })

  const move = defineOp({
    name: "drive.move",
    args: obj({ scope: ScopeSchema, from: Path, to: Path, toScope: opt(ScopeSchema) }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, from, to, toScope }) => {
      const [source, destination] = [await requireRoot(scope), await requireRoot(toScope ?? scope)]
      const [fromPath, toPath] = [inside(source, from), inside(destination, to)]
      const link = await shares.idOf(fromPath)
      if (!(await deps.files.move(fromPath, toPath)))
        throw new OpRejected("bad_args", `cannot move ${from}: it is missing or ${to} exists`)
      if (link !== undefined) await shares.carry(link, toPath)
      const entry = await deps.files.stat(toPath)
      if (entry === undefined) throw new Error(`${to} vanished after the move`)
      return relative(destination, entry)
    },
  })

  const remove = defineOp({
    name: "drive.delete",
    args: obj({ scope: ScopeSchema, path: Path }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, path }) => ({
      deleted: await deps.files.remove(inside(await requireRoot(scope), path)),
    }),
  })

  const history = defineOp({
    name: "drive.history",
    read: true,
    args: obj({ scope: ScopeSchema, path: Path }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, path }) => {
      const root = await requireRoot(scope)
      const target = inside(root, path)
      const entry = await deps.files.stat(target)
      if (entry === undefined) throw new OpRejected("bad_args", `no file ${path}`)
      const versions = (await deps.files.revisions(target)).filter((version) => version.sha256 !== entry.sha256)
      return {
        path: target.slice(root.length),
        current: { sha256: entry.sha256, size: entry.size, type: entry.type, at: entry.updated_at },
        versions,
      }
    },
  })

  const checkout = defineOp({
    name: "drive.checkout",
    args: obj({ scope: ScopeSchema, path: Path, sha256: Sha }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, path, sha256 }) => {
      const root = await requireRoot(scope)
      const restored = await deps.files.restore(inside(root, path), sha256)
      if (restored === undefined) throw new OpRejected("bad_args", `no version ${sha256} of ${path}`)
      return relative(root, restored)
    },
  })

  const share = defineOp({
    name: "drive.share",
    args: obj({ scope: ScopeSchema, path: Path }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, path }) => {
      const target = inside(await requireRoot(scope), path)
      const id = await shares.share(target)
      if (id === undefined) throw new OpRejected("bad_args", `no file ${path}`)
      return { id, url: `/s/${id}/${encodeURIComponent(target.slice(target.lastIndexOf("/") + 1))}` }
    },
  })

  const unshare = defineOp({
    name: "drive.unshare",
    args: obj({ scope: ScopeSchema, path: Path }),
    actors: ["owner", "plugin"],
    run: async (_api, { scope, path }) => ({ revoked: await shares.unshare(inside(await requireRoot(scope), path)) }),
  })

  const scopes = defineOp({
    name: "drive.scopes",
    read: true,
    args: obj({ conversationId: opt(int({ minimum: 0 })) }),
    actors: ["owner", "plugin"],
    run: async (api, { conversationId }) => {
      if (conversationId !== undefined)
        return (await scopesOf(conversationId as ConversationId)).map(({ scope, root, label }) => ({
          scope,
          root,
          label,
        }))
      const workspace = await api.harness.snapshot(WorkspaceDoc, context)
      const projects = Object.entries(workspace?.projects ?? {}).filter(([, project]) => !project.archived)
      return [
        { scope: { kind: "user" }, root: "/me/", label: "user" },
        ...projects.map(([id, project]) => ({
          scope: { kind: "project", id },
          root: `/projects/${project.slug}/`,
          label: `project ${project.slug}`,
        })),
      ]
    },
  })

  return {
    service,
    ops: [list, read, write, move, remove, history, checkout, share, unshare, scopes],
    extension: defineExtension({ name: "drive", sections: [instructionsSection] }),
    grant: async (conversationId, path) => {
      for (const mounted of await scopesOf(conversationId))
        if ((mounted.scope.kind === "captain" || mounted.scope.kind === "automation") && path.startsWith(mounted.root))
          return true
      return false
    },
    changed,
  }
}
