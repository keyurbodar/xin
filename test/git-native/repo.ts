import { deflateSync } from "node:zlib"
import git, { TREE, walk } from "isomorphic-git"
import http from "isomorphic-git/http/web"
import { MemFS } from "./fs.ts"
import { buildIndex, type GitObject, PackReader, readIndex, type Sha1 } from "./pack.ts"
import { fetchPack } from "./smart.ts"
import type { CountingStore, Store } from "./store.ts"

const DIR = "/repo"
const GITDIR = `${DIR}/.git`

export type Mode = "pack" | "loose"

export type Meta = {
  readonly url: string
  readonly ref: string
  readonly branch: string
  readonly head: string
  readonly mode: Mode
  readonly depth: number | null
  readonly packName: string | null
  readonly objects: number
  readonly packBytes: number
  readonly shallow: readonly string[]
}

export type Phase = { readonly name: string; readonly ms: number }

export type Timed<T> = {
  readonly ms: number
  readonly reads: number
  readonly writes: number
  readonly lists: number
  readonly bytesRead: number
  readonly bytesWritten: number
  readonly fetches: number
  readonly fetchBytes: number
  readonly value: T
}

export type Clock = () => number

const text = (data: Uint8Array): string => new TextDecoder().decode(data)

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

/** Wraps the web http client so the clone can report what the network cost. */
function countingHttp(): { client: typeof http; phases: Phase[]; counters: { fetches: number; bytes: number } } {
  const phases: Phase[] = []
  const counters = { fetches: 0, bytes: 0 }
  const client = {
    async request(request: Parameters<typeof http.request>[0]) {
      const started = performance.now()
      const response = await http.request(request)
      const body = response.body as unknown as AsyncIterable<Uint8Array> | undefined
      const counted =
        body === undefined
          ? undefined
          : (async function* () {
              for await (const chunk of body) {
                counters.bytes += chunk.byteLength
                yield chunk
              }
            })()
      phases.push({
        name: `${request.method ?? "GET"} ${request.url.replace(/^https:\/\//, "")}`,
        ms: performance.now() - started,
      })
      counters.fetches += 1
      return { ...response, ...(counted === undefined ? {} : { body: counted }) }
    },
  }
  return { client: client as unknown as typeof http, phases, counters }
}

async function packFiles(fs: MemFS): Promise<{ pack: Uint8Array; idx: Uint8Array; name: string }> {
  const names = await fs.readdir(`${GITDIR}/objects/pack`)
  const packName = names.find((name) => name.endsWith(".pack"))
  if (packName === undefined) throw new Error("the clone produced no packfile")
  const pack = (await fs.readFile(`${GITDIR}/objects/pack/${packName}`)) as Uint8Array
  const idx = (await fs.readFile(`${GITDIR}/objects/pack/${packName.replace(/\.pack$/, ".idx")}`)) as Uint8Array
  return { pack, idx, name: packName }
}

async function explode(
  store: Store,
  index: ReturnType<typeof readIndex>,
  prefix: string,
  started: number,
): Promise<Phase[]> {
  const phases: Phase[] = []
  const reader = new PackReader(index)
  let bytes = 0
  const one = performance.now()
  for (const oid of index.oids) {
    const object = reader.read(oid)
    const header = encode(`${object.kind} ${object.data.length}\u0000`)
    const loose = new Uint8Array(header.length + object.data.length)
    loose.set(header)
    loose.set(object.data, header.length)
    const deflated = deflateSync(loose)
    bytes += deflated.byteLength
    await store.put(`${prefix}/o/${oid}`, new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength))
  }
  phases.push({ name: `explode ${index.oids.length} objects to loose (${bytes} B)`, ms: performance.now() - one })
  phases.push({ name: "clone total", ms: performance.now() - started })
  return phases
}

export type CloneOutcome = {
  readonly meta: Meta
  readonly phases: readonly Phase[]
  readonly fetches: number
  readonly fetchBytes: number
  readonly writes: number
  readonly bytesWritten: number
  readonly ms: number
}

export async function cloneInto(
  store: Store,
  prefix: string,
  options: { readonly url: string; readonly ref?: string; readonly depth?: number; readonly mode: Mode },
): Promise<CloneOutcome> {
  const started = performance.now()
  const fs = new MemFS()
  const net = countingHttp()
  const phases: Phase[] = []
  const cloneStart = performance.now()
  await git.clone({
    fs,
    http: net.client,
    dir: DIR,
    url: options.url,
    singleBranch: true,
    noCheckout: true,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
  })
  phases.push({ name: "git.clone", ms: performance.now() - cloneStart })
  const head = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" })
  const branch = await git.currentBranch({ fs, dir: DIR, fullname: false })
  const files = await packFiles(fs)
  const shallowFile = await fs.readFile(`${GITDIR}/shallow`, "utf8").catch(() => "")
  const shallow = String(shallowFile)
    .split("\n")
    .filter((line) => line.trim() !== "")
  const index = readIndex(files.pack, files.idx)
  const storeStart = performance.now()
  await store.put(`${prefix}/pack.pack`, files.pack)
  await store.put(`${prefix}/pack.idx`, files.idx)
  phases.push({ name: "write pack + idx to R2", ms: performance.now() - storeStart })
  const meta: Meta = {
    url: options.url,
    ref: options.ref ?? "HEAD",
    branch: branch ?? "main",
    head,
    mode: options.mode,
    depth: options.depth ?? null,
    packName: files.name,
    objects: index.oids.length,
    packBytes: files.pack.byteLength,
    shallow,
  }
  await store.put(`${prefix}/meta.json`, encode(JSON.stringify(meta)))
  if (options.mode === "loose") phases.push(...(await explode(store, index, prefix, started)))
  return {
    meta,
    phases,
    fetches: net.counters.fetches,
    fetchBytes: net.counters.bytes,
    writes: 0,
    bytesWritten: 0,
    ms: performance.now() - started,
  }
}

export type NativeCloneOutcome = {
  readonly meta: Meta
  readonly phases: readonly Phase[]
  readonly fetches: number
  readonly fetchBytes: number
  readonly writes: number
  readonly bytesWritten: number
  readonly ms: number
  readonly retained: number
}

/** Clone without a git library: one upload-pack round trip, one index build, two R2 writes. */
export async function nativeClone(
  store: Store,
  prefix: string,
  options: { readonly url: string; readonly depth?: number; readonly sha1: Sha1; readonly budget?: number },
): Promise<NativeCloneOutcome> {
  const started = performance.now()
  const fetched = await fetchPack({
    url: options.url,
    ...(options.depth === undefined ? {} : { depth: options.depth }),
  })
  const indexed = await buildIndex(fetched.pack, options.sha1, options.budget ?? 16 * 1048576)
  const indexMs = performance.now() - started - fetched.refsMs - fetched.packMs
  const writeStart = performance.now()
  await store.put(`${prefix}/pack.pack`, fetched.pack)
  await store.put(`${prefix}/pack.idx`, indexed.idx)
  const meta: Meta = {
    url: options.url,
    ref: "HEAD",
    branch: fetched.branch,
    head: fetched.head,
    mode: "pack",
    depth: options.depth ?? null,
    packName: `pack-${fetched.head.slice(0, 8)}.pack`,
    objects: indexed.hashed,
    packBytes: fetched.pack.byteLength,
    shallow: fetched.shallow,
  }
  await store.put(`${prefix}/meta.json`, encode(JSON.stringify(meta)))
  const writeMs = performance.now() - writeStart
  return {
    meta,
    phases: [
      { name: `refs (${fetched.fetches} fetch, ${fetched.bytes} B)`, ms: fetched.refsMs },
      { name: `pack download ${(fetched.pack.byteLength / 1024).toFixed(0)} KB`, ms: fetched.packMs },
      { name: `build index (${indexed.hashed} objects)`, ms: indexMs },
      { name: "write pack + idx to R2", ms: writeMs },
    ],
    fetches: fetched.fetches,
    fetchBytes: fetched.bytes,
    writes: 3,
    bytesWritten: fetched.pack.byteLength + indexed.idx.byteLength,
    ms: performance.now() - started,
    retained: indexed.peakRetainedBytes,
  }
}

export type Opened = {
  readonly meta: Meta
  readonly fs: MemFS
  readonly pack: PackReader | undefined
}

export async function open(store: Store, prefix: string): Promise<Opened> {
  const raw = await store.get(`${prefix}/meta.json`)
  if (raw === undefined) throw new Error(`no repository at ${prefix}`)
  const meta = JSON.parse(text(raw)) as Meta
  const fs = new MemFS()
  fs.write(`${GITDIR}/HEAD`, `ref: refs/heads/${meta.branch}\n`)
  fs.write(`${GITDIR}/refs/heads/${meta.branch}`, `${meta.head}\n`)
  fs.write(`${GITDIR}/config`, "[core]\n\trepositoryformatversion = 0\n\tbare = false\n")
  if (meta.shallow.length > 0) fs.write(`${GITDIR}/shallow`, `${meta.shallow.join("\n")}\n`)
  let pack: PackReader | undefined
  if (meta.mode === "pack") {
    const packBytes = await store.get(`${prefix}/pack.pack`)
    const idxBytes = await store.get(`${prefix}/pack.idx`)
    if (packBytes === undefined || idxBytes === undefined) throw new Error("the pack is missing")
    fs.write(`${GITDIR}/objects/pack/pack-0.pack`, packBytes)
    fs.write(`${GITDIR}/objects/pack/pack-0.idx`, idxBytes)
    pack = new PackReader(readIndex(packBytes, idxBytes))
  } else {
    const keys = await store.list(`${prefix}/o/`)
    for (const key of keys) await fs.mkdir(`${GITDIR}/objects/${key.slice(-40, -38)}`)
    fs.onMiss(`${GITDIR}/objects/`, async (path) => {
      const parts = path.split("/")
      const oid = `${parts.at(-2) ?? ""}${parts.at(-1) ?? ""}`
      return store.get(`${prefix}/o/${oid}`)
    })
  }
  return { meta, fs, pack }
}

export async function time<T>(store: CountingStore, run: () => Promise<T>): Promise<Timed<T>> {
  const before = { ...store.counters }
  const started = performance.now()
  const value = await run()
  const after = store.counters
  return {
    ms: performance.now() - started,
    reads: after.reads - before.reads,
    writes: after.writes - before.writes,
    lists: after.lists - before.lists,
    bytesRead: after.bytesRead - before.bytesRead,
    bytesWritten: after.bytesWritten - before.bytesWritten,
    fetches: after.fetches - before.fetches,
    fetchBytes: after.fetchBytes - before.fetchBytes,
    value,
  }
}

export type Commit = {
  readonly sha: string
  readonly date: string
  readonly author: string
  readonly subject: string
  readonly parents: readonly string[]
}

function parseCommit(oid: string, object: GitObject): Commit {
  const body = text(object.data)
  const head = body.slice(0, body.indexOf("\n\n"))
  const message = body.slice(body.indexOf("\n\n") + 2)
  const header = (name: string): string =>
    head
      .split("\n")
      .find((line) => line.startsWith(`${name} `))
      ?.slice(name.length + 1) ?? ""
  const author = header("author")
  const cut = author.lastIndexOf(">")
  const who = author.slice(0, Math.max(0, author.indexOf(" <")))
  const epoch = Number(author.slice(cut + 2).split(" ")[0] ?? "0")
  const parents = head
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7))
  return {
    sha: oid,
    date: new Date(epoch * 1000).toISOString(),
    author: who,
    subject: message.split("\n")[0] ?? "",
    parents,
  }
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

/** Walks every parent in committer-date order, the way `git log` does, stopping at the shallow boundary. */
export function logNative(pack: PackReader, head: string, limit: number): Commit[] {
  const commits: Commit[] = []
  const seen = new Set<string>()
  const queue: Commit[] = []
  const push = (oid: string): void => {
    if (seen.has(oid) || !pack.index.offsets.has(oid)) return
    seen.add(oid)
    const object = pack.read(oid)
    if (object.kind !== "commit") throw new Error(`${oid} is a ${object.kind}, not a commit`)
    queue.push(parseCommit(oid, object))
  }
  push(head)
  while (commits.length < limit) {
    const next = takeNewest(queue)
    if (next === undefined) break
    commits.push(next)
    for (const parent of next.parents) push(parent)
  }
  return commits
}

export async function logIso(opened: Opened, limit: number): Promise<Commit[]> {
  const rows = await git.log({ fs: opened.fs, dir: DIR, ref: opened.meta.branch, depth: limit })
  return rows.map((row) => ({
    sha: row.oid,
    date: new Date(row.commit.committer.timestamp * 1000).toISOString(),
    author: row.commit.author.name,
    subject: row.commit.message.split("\n")[0] ?? "",
    parents: row.commit.parent,
  }))
}

type TreeEntry = { readonly mode: string; readonly name: string; readonly oid: string }

function parseTree(pack: PackReader, oid: string): TreeEntry[] {
  const data = pack.read(oid).data
  const entries: TreeEntry[] = []
  let index = 0
  while (index < data.length) {
    const space = data.indexOf(0x20, index)
    const nul = data.indexOf(0, space)
    const mode = text(data.subarray(index, space))
    const name = text(data.subarray(space + 1, nul))
    let offset = nul + 1
    let oid20 = ""
    for (let i = 0; i < 20; i += 1) {
      oid20 += (data[offset + i] ?? 0).toString(16).padStart(2, "0")
    }
    offset += 20
    entries.push({ mode, name, oid: oid20 })
    index = offset
  }
  return entries
}

function resolvePath(pack: PackReader, commitOid: string, path: string): string | undefined {
  const commit = pack.read(commitOid)
  const treeLine = text(commit.data)
    .split("\n")
    .find((line) => line.startsWith("tree "))
  let tree = treeLine?.slice(5)
  if (tree === undefined) return undefined
  const parts = path.split("/").filter((part) => part !== "")
  for (const part of parts) {
    const found: TreeEntry | undefined = parseTree(pack, tree).find((candidate) => candidate.name === part)
    if (found === undefined) return undefined
    tree = found.oid
  }
  return tree
}

export type Shown = { readonly sha: string; readonly path: string; readonly bytes: number; readonly text: string }

export function showNative(pack: PackReader, commit: string, path: string): Shown {
  const oid = resolvePath(pack, commit, path)
  if (oid === undefined) throw new Error(`${path} is not in ${commit}`)
  const object = pack.read(oid)
  return { sha: oid, path, bytes: object.data.length, text: text(object.data) }
}

export async function showIso(opened: Opened, commit: string, path: string): Promise<Shown> {
  const blob = await git.readBlob({ fs: opened.fs, dir: DIR, oid: commit, filepath: path })
  return { sha: blob.oid, path, bytes: blob.blob.length, text: text(blob.blob) }
}

type Flat = Map<string, string>

function flatten(pack: PackReader, treeOid: string, base: string, into: Flat): Flat {
  for (const entry of parseTree(pack, treeOid)) {
    const path = base === "" ? entry.name : `${base}/${entry.name}`
    if (entry.mode === "40000") flatten(pack, entry.oid, path, into)
    else into.set(path, entry.oid)
  }
  return into
}

function treeOf(pack: PackReader, commitOid: string): string {
  const line = text(pack.read(commitOid).data)
    .split("\n")
    .find((candidate) => candidate.startsWith("tree "))
  if (line === undefined) throw new Error(`${commitOid} has no tree`)
  return line.slice(5)
}

function lines(data: Uint8Array): string[] {
  return text(data).split("\n")
}

/** A line diff by longest common subsequence, capped so a huge file cannot dominate a request. */
export function patchOf(before: Uint8Array, after: Uint8Array, maxLines = 400): string {
  const a = lines(before)
  const b = lines(after)
  if (a.length * b.length > 4_000_000) return "(file too large to diff)"
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length && out.length < maxLines) {
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
  while (i < a.length && out.length < maxLines) {
    out.push(`-${a[i] ?? ""}`)
    i += 1
  }
  while (j < b.length && out.length < maxLines) {
    out.push(`+${b[j] ?? ""}`)
    j += 1
  }
  return out.join("\n")
}

export type FileDiff = {
  readonly path: string
  readonly status: "added" | "removed" | "modified"
  readonly added: number
  readonly removed: number
  readonly patch: string
}

export function diffNative(pack: PackReader, base: string, head: string): FileDiff[] {
  const before = flatten(pack, treeOf(pack, base), "", new Map())
  const after = flatten(pack, treeOf(pack, head), "", new Map())
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted()
  const diffs: FileDiff[] = []
  for (const path of paths) {
    const from = before.get(path)
    const to = after.get(path)
    if (from === to) continue
    const a = from === undefined ? new Uint8Array() : pack.read(from).data
    const b = to === undefined ? new Uint8Array() : pack.read(to).data
    const patch = patchOf(a, b)
    diffs.push({
      path,
      status: from === undefined ? "added" : to === undefined ? "removed" : "modified",
      added: patch.split("\n").filter((line) => line.startsWith("+")).length,
      removed: patch.split("\n").filter((line) => line.startsWith("-")).length,
      patch,
    })
  }
  return diffs
}

/** isomorphic-git 1.44 exposes `oid` and `type` as functions on a walker entry, and as strings on older shapes. */
async function field(entry: unknown, name: "oid" | "type"): Promise<string | undefined> {
  const value = (entry as Record<string, unknown> | undefined)?.[name]
  if (typeof value === "string") return value
  if (typeof value === "function") return (await (value as () => Promise<string>).call(entry)) as string
  return undefined
}

export async function diffIso(opened: Opened, base: string, head: string): Promise<FileDiff[]> {
  const seen = new Map<string, FileDiff>()
  await walk({
    fs: opened.fs,
    dir: DIR,
    trees: [TREE({ ref: base }), TREE({ ref: head })],
    map: async (path, entries) => {
      if (path === ".") return
      const [a, b] = entries
      if (a === undefined || b === undefined) return
      if ((await field(a, "type")) === "tree" || (await field(b, "type")) === "tree") return
      const before = await field(a, "oid")
      const after = await field(b, "oid")
      if (before === after) return
      const content = async (entry: typeof a): Promise<Uint8Array> => {
        if (entry === undefined || entry === null) return new Uint8Array()
        if ((await field(entry, "oid")) === undefined) return new Uint8Array()
        return (await entry.content()) ?? new Uint8Array()
      }
      const patch = patchOf(await content(a), await content(b))
      seen.set(path, {
        path,
        status: before === undefined ? "added" : after === undefined ? "removed" : "modified",
        added: patch.split("\n").filter((line) => line.startsWith("+")).length,
        removed: patch.split("\n").filter((line) => line.startsWith("-")).length,
        patch,
      })
      return undefined
    },
  })
  return [...seen.values()].toSorted((left, right) => left.path.localeCompare(right.path))
}

export { DIR, GITDIR }
