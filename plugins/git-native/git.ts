import type { DbService } from "../../src/kernel/db.ts"
import { PackObjects } from "./objects.ts"
import { buildIndex, type GitObject, subtleSha1 } from "./pack.ts"
import { advertise, type Fetched, type Fetcher, fetchPack, remoteUrl } from "./protocol.ts"
import { PackStore, RepoIndex, type RepoRow } from "./store.ts"

export const MAX_PACK_BYTES = 80 * 1024 * 1024
const MAX_DEPTH = 5_000
const SCAN_LIMIT = 1_000
const BLOB_CACHE = 32

export type Port = {
  readonly db: DbService
  readonly bucket: R2Bucket
  readonly fetcher: Fetcher
  readonly now: () => number
}

const hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/** One project's copy of one remote: a different project always gets its own storage. */
export const repoId = (project: string, url: string): Promise<string> => hex(`${project}\n${url}`)

const blobs = new Map<string, Uint8Array>()

export type Cloned = {
  readonly row: RepoRow
  readonly reused: boolean
  readonly bytes: number
  readonly fetches: number
  readonly ms: number
}

/** Clones or refreshes one public remote into R2. A refresh with an unchanged head costs two requests and no pack. */
export async function cloneInto(
  port: Port,
  options: {
    readonly project: string
    readonly url: string
    readonly ref?: string
    readonly depth?: number
    readonly maxBytes?: number
  },
): Promise<Cloned> {
  const started = performance.now()
  const url = remoteUrl(options.url)
  const id = await repoId(options.project, url)
  const repos = new RepoIndex(port.db)
  const packs = new PackStore(port.bucket)
  const existing = await repos.get(id)
  const partial = existing !== undefined && existing.partial === 1
  const wanted = {
    url,
    maxBytes: options.maxBytes ?? MAX_PACK_BYTES,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.depth === undefined ? {} : { depth: Math.min(options.depth, MAX_DEPTH) }),
  }

  let fetched: Fetched | undefined
  let bytes = 0
  let fetches = 0
  if (existing !== undefined) {
    const probe = await advertise(port.fetcher, wanted)
    bytes += probe.bytes
    fetches += probe.fetches
    if (probe.refs.head === existing.head) {
      const row = { ...existing, fetched_at: port.now() }
      await repos.save(row)
      await repos.saveRefs(id, probe.refs.refs)
      return { row, reused: true, bytes, fetches, ms: performance.now() - started }
    }
  }

  let mode = partial
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await fetchPack(port.fetcher, { ...wanted, blobs: !mode })
    bytes += outcome.bytes
    fetches += outcome.fetches
    if (!("tooLarge" in outcome)) {
      fetched = outcome
      break
    }
    if (mode) break
    mode = true
  }
  if (fetched === undefined)
    throw new Error(
      `this repository is too large to read on the Worker: even a history-only clone passes the ${Math.round((options.maxBytes ?? MAX_PACK_BYTES) / 1048576)} MB limit`,
    )

  const built = await buildIndex(fetched.pack, subtleSha1)
  await packs.put(id, fetched.pack, built.idx, built.spans)
  const row: RepoRow = {
    id,
    project: options.project,
    url,
    branch: fetched.refs.branch.replace(/^refs\/heads\//, ""),
    head: fetched.refs.head,
    partial: mode ? 1 : 0,
    pack_bytes: fetched.pack.byteLength,
    objects: built.hashed,
    fetched_at: port.now(),
  }
  await repos.save(row)
  await repos.saveRefs(id, fetched.refs.refs)
  await repos.saveShallow(id, fetched.shallow)
  return { row, reused: false, bytes, fetches, ms: performance.now() - started }
}

export type Reader = {
  readonly row: RepoRow
  readonly objects: PackObjects
  readonly shallow: ReadonlySet<string>
  readonly refs: ReadonlyMap<string, string>
}

export async function open(port: Port, id: string): Promise<Reader | undefined> {
  const row = await new RepoIndex(port.db).get(id)
  if (row === undefined) return undefined
  const repos = new RepoIndex(port.db)
  const opened = await new PackStore(port.bucket).open(id, row.pack_bytes)
  return {
    row,
    objects: new PackObjects(opened.index, opened.spans, opened.source),
    shallow: await repos.shallow(id),
    refs: await repos.refs(id),
  }
}

const NAME = /^refs\/(heads|tags)\//

/** A ref name, `HEAD`, `HEAD~3`, a tag or a full object id, resolved from SQLite rather than from the pack. */
export async function resolveRef(reader: Reader, ref: string | undefined): Promise<string> {
  if (ref === undefined || ref === "" || ref === "HEAD") return reader.row.head
  const tilde = /^(.+?)~(\d+)$/.exec(ref)
  if (tilde?.[1] !== undefined && tilde[2] !== undefined) {
    let oid = await resolveRef(reader, tilde[1])
    for (let step = 0; step < Number(tilde[2]); step += 1) {
      const parent = (await commitOf(reader, oid)).parents[0]
      if (parent === undefined || !reader.objects.has(parent))
        throw new Error(`${ref} goes past the history this clone keeps`)
      oid = parent
    }
    return oid
  }
  if (/^[0-9a-f]{40}$/.test(ref)) return ref
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/remotes/origin/${ref}`]
  for (const candidate of candidates) {
    const oid = reader.refs.get(candidate)
    if (oid !== undefined) return oid
  }
  for (const [name, oid] of reader.refs) if (NAME.test(name) && name.endsWith(`/${ref}`)) return oid
  throw new Error(`no ref named "${ref}" in this repository`)
}

export type Commit = {
  readonly sha: string
  readonly date: string
  readonly author: string
  readonly subject: string
  readonly parents: readonly string[]
}

function parseCommit(oid: string, object: GitObject): Commit {
  const body = new TextDecoder().decode(object.data)
  const split = body.indexOf("\n\n")
  const head = split === -1 ? body : body.slice(0, split)
  const message = split === -1 ? "" : body.slice(split + 2)
  const header = (name: string): string =>
    head
      .split("\n")
      .find((line) => line.startsWith(`${name} `))
      ?.slice(name.length + 1) ?? ""
  const author = header("author")
  const close = author.lastIndexOf(">")
  const name = author.slice(0, Math.max(0, author.indexOf(" <")))
  const epoch = Number(author.slice(close + 2).split(" ")[0] ?? "0")
  return {
    sha: oid,
    date: new Date(epoch * 1000).toISOString(),
    author: name,
    subject: message.split("\n")[0] ?? "",
    parents: head
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice(7)),
  }
}

const commitOf = async (reader: Reader, oid: string): Promise<Commit> => {
  const object = await reader.objects.read(oid)
  if (object.kind !== "commit") throw new Error(`${oid} is a ${object.kind}, not a commit`)
  return parseCommit(oid, object)
}

function takeNewest(queue: Commit[]): Commit | undefined {
  let newest = -1
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index]
    const leader = newest === -1 ? undefined : queue[newest]
    if (candidate !== undefined && (leader === undefined || candidate.date > leader.date)) newest = index
  }
  return newest === -1 ? undefined : queue.splice(newest, 1)[0]
}

export type LogOptions = { readonly ref?: string; readonly path?: string; readonly limit: number }

export type LogResult = { readonly commits: readonly Commit[]; readonly scanned: number; readonly truncated: boolean }

export async function log(reader: Reader, options: LogOptions): Promise<LogResult> {
  const start = await resolveRef(reader, options.ref)
  const commits: Commit[] = []
  const seen = new Set<string>()
  const queue: Commit[] = []
  let scanned = 0
  const push = async (oid: string): Promise<void> => {
    if (seen.has(oid) || !reader.objects.has(oid)) return
    seen.add(oid)
    queue.push(await commitOf(reader, oid))
  }
  await push(start)
  while (commits.length < options.limit) {
    const next = takeNewest(queue)
    if (next === undefined) break
    scanned += 1
    if (scanned > SCAN_LIMIT) return { commits, scanned, truncated: true }
    if (options.path === undefined || (await touches(reader, next, options.path))) commits.push(next)
    for (const parent of next.parents) await push(parent)
  }
  return { commits, scanned, truncated: queue.length > 0 && commits.length >= options.limit }
}

type TreeEntry = { readonly mode: string; readonly name: string; readonly oid: string }

async function parseTree(reader: Reader, oid: string): Promise<TreeEntry[]> {
  const data = (await reader.objects.read(oid)).data
  const entries: TreeEntry[] = []
  let index = 0
  while (index < data.length) {
    const space = data.indexOf(0x20, index)
    const nul = data.indexOf(0, space)
    const mode = new TextDecoder().decode(data.subarray(index, space))
    const name = new TextDecoder().decode(data.subarray(space + 1, nul))
    let offset = nul + 1
    let child = ""
    for (let i = 0; i < 20; i += 1) child += (data[offset + i] ?? 0).toString(16).padStart(2, "0")
    offset += 20
    entries.push({ mode, name, oid: child })
    index = offset
  }
  return entries
}

const treeOf = async (reader: Reader, commit: Commit): Promise<string> => {
  const object = await reader.objects.read(commit.sha)
  const line = new TextDecoder()
    .decode(object.data)
    .split("\n")
    .find((candidate) => candidate.startsWith("tree "))
  if (line === undefined) throw new Error(`${commit.sha} has no tree`)
  return line.slice(5)
}

/** The object id of `path` in a commit, or undefined when the commit does not carry it. */
async function pathOid(reader: Reader, commit: Commit, path: string): Promise<string | undefined> {
  let tree = await treeOf(reader, commit)
  const parts = path.split("/").filter((part) => part !== "")
  for (const [index, part] of parts.entries()) {
    const entry = (await parseTree(reader, tree)).find((candidate) => candidate.name === part)
    if (entry === undefined) return undefined
    if (index === parts.length - 1) return entry.oid
    if (entry.mode !== "40000") return undefined
    tree = entry.oid
  }
  return tree
}

async function touches(reader: Reader, commit: Commit, path: string): Promise<boolean> {
  const own = await pathOid(reader, commit, path)
  if (commit.parents.length === 0) return own !== undefined
  for (const parent of commit.parents) {
    if (!reader.objects.has(parent)) return own !== undefined
    if ((await pathOid(reader, await commitOf(reader, parent), path)) !== own) return true
  }
  return false
}

export type Shown = { readonly path: string; readonly sha: string; readonly bytes: number; readonly text: string }

/** A file at a revision. A partial clone fetches the one blob it needs. */
export async function show(
  port: Port,
  reader: Reader,
  options: { readonly ref?: string; readonly path: string },
): Promise<Shown> {
  const commit = await commitOf(reader, await resolveRef(reader, options.ref))
  const oid = await pathOid(reader, commit, options.path)
  if (oid === undefined) throw new Error(`${options.path} is not in ${commit.sha.slice(0, 7)}`)
  let data: Uint8Array
  if (reader.objects.has(oid)) {
    const object = await reader.objects.read(oid)
    if (object.kind !== "blob") throw new Error(`${options.path} is a ${object.kind}, not a file`)
    data = object.data
  } else {
    data = await fetchBlob(port, reader, oid)
  }
  return { path: options.path, sha: oid, bytes: data.length, text: new TextDecoder().decode(data) }
}

async function fetchBlob(port: Port, reader: Reader, oid: string): Promise<Uint8Array> {
  const cached = blobs.get(oid)
  if (cached !== undefined) return cached
  const outcome = await fetchPack(port.fetcher, { url: reader.row.url, wants: [oid], maxBytes: MAX_PACK_BYTES })
  if ("tooLarge" in outcome) throw new Error("that file is too large to fetch")
  const built = await buildIndex(outcome.pack, subtleSha1)
  const objects = new PackObjects(built.index, built.spans, {
    length: outcome.pack.byteLength,
    bytes: async (offset, length) => outcome.pack.subarray(offset, offset + length),
  })
  const data = (await objects.read(oid)).data
  blobs.set(oid, data)
  while (blobs.size > BLOB_CACHE) blobs.delete(blobs.keys().next().value ?? "")
  return data
}

export type FileDiff = {
  readonly path: string
  readonly status: "added" | "removed" | "modified"
  readonly patch: string | null
}

async function flatten(
  reader: Reader,
  tree: string,
  base: string,
  into: Map<string, string>,
): Promise<Map<string, string>> {
  for (const entry of await parseTree(reader, tree)) {
    const path = base === "" ? entry.name : `${base}/${entry.name}`
    if (entry.mode === "40000") await flatten(reader, entry.oid, path, into)
    else into.set(path, entry.oid)
  }
  return into
}

const MAX_DIFF_CELLS = 4_000_000
const MAX_PATCH_LINES = 400

/** A line diff by longest common subsequence, capped so one huge file cannot dominate a request. */
export function patchOf(before: Uint8Array, after: Uint8Array): string {
  const a = new TextDecoder().decode(before).split("\n")
  const b = new TextDecoder().decode(after).split("\n")
  if (a.length * b.length > MAX_DIFF_CELLS) return "(file too large to diff line by line)"
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i] === b[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length && out.length < MAX_PATCH_LINES) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      out.push(`-${a[i] ?? ""}`)
      i += 1
    } else {
      out.push(`+${b[j] ?? ""}`)
      j += 1
    }
  }
  while (i < a.length && out.length < MAX_PATCH_LINES) {
    out.push(`-${a[i] ?? ""}`)
    i += 1
  }
  while (j < b.length && out.length < MAX_PATCH_LINES) {
    out.push(`+${b[j] ?? ""}`)
    j += 1
  }
  return out.join("\n")
}

export type DiffOptions = { readonly base: string; readonly head?: string; readonly path?: string }

/** Two revisions, compared by tree. A partial clone reports which files changed and leaves the patch out. */
export async function diff(reader: Reader, options: DiffOptions): Promise<FileDiff[]> {
  const before = await commitOf(reader, await resolveRef(reader, options.base))
  const after = await commitOf(reader, await resolveRef(reader, options.head))
  const from = await flatten(reader, await treeOf(reader, before), "", new Map())
  const to = await flatten(reader, await treeOf(reader, after), "", new Map())
  const paths = [...new Set([...from.keys(), ...to.keys()])]
    .filter((path) => options.path === undefined || path === options.path)
    .toSorted()
  const diffs: FileDiff[] = []
  for (const path of paths) {
    const a = from.get(path)
    const b = to.get(path)
    if (a === b) continue
    const present = a === undefined || reader.objects.has(a)
    const presentB = b === undefined || reader.objects.has(b)
    const patch =
      present && presentB
        ? patchOf(
            a === undefined ? new Uint8Array() : (await reader.objects.read(a)).data,
            b === undefined ? new Uint8Array() : (await reader.objects.read(b)).data,
          )
        : null
    diffs.push({ path, status: a === undefined ? "added" : b === undefined ? "removed" : "modified", patch })
  }
  return diffs
}
