import type { SqliteMigration } from "@earendil-works/chord/sqlite"
import type { DbService } from "../../src/kernel/db.ts"
import { type ByteSource, type PackIndex, readIndex } from "./pack.ts"

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE git_native_repo (id TEXT PRIMARY KEY, project TEXT NOT NULL, url TEXT NOT NULL, branch TEXT NOT NULL, head TEXT NOT NULL, partial INTEGER NOT NULL DEFAULT 0, pack_bytes INTEGER NOT NULL, objects INTEGER NOT NULL, fetched_at INTEGER NOT NULL)",
      "CREATE INDEX git_native_repo_project ON git_native_repo (project)",
      "CREATE TABLE git_native_ref (repo TEXT NOT NULL, name TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY (repo, name))",
      "CREATE TABLE git_native_shallow (repo TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY (repo, oid))",
    ],
  },
]

export type RepoRow = {
  readonly id: string
  readonly project: string
  readonly url: string
  readonly branch: string
  readonly head: string
  readonly partial: number
  readonly pack_bytes: number
  readonly objects: number
  readonly fetched_at: number
}

const COLUMNS = "id, project, url, branch, head, partial, pack_bytes, objects, fetched_at"

/** Repositories, their refs and their shallow boundary. Nothing here is re-derived from the pack on a read. */
export class RepoIndex {
  readonly #db: DbService

  constructor(db: DbService) {
    this.#db = db
  }

  async get(id: string): Promise<RepoRow | undefined> {
    return this.#db.get<RepoRow>(`SELECT ${COLUMNS} FROM git_native_repo WHERE id = ?`, id)
  }

  async under(project: string): Promise<RepoRow[]> {
    return this.#db.all<RepoRow>(`SELECT ${COLUMNS} FROM git_native_repo WHERE project = ? ORDER BY url`, project)
  }

  async save(row: RepoRow): Promise<void> {
    await this.#db.run(
      `INSERT INTO git_native_repo (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET project = excluded.project, url = excluded.url, branch = excluded.branch,
         head = excluded.head, partial = excluded.partial, pack_bytes = excluded.pack_bytes,
         objects = excluded.objects, fetched_at = excluded.fetched_at`,
      row.id,
      row.project,
      row.url,
      row.branch,
      row.head,
      row.partial,
      row.pack_bytes,
      row.objects,
      row.fetched_at,
    )
  }

  async forget(id: string): Promise<void> {
    await this.#db.run("DELETE FROM git_native_repo WHERE id = ?", id)
    await this.#db.run("DELETE FROM git_native_ref WHERE repo = ?", id)
    await this.#db.run("DELETE FROM git_native_shallow WHERE repo = ?", id)
  }

  async refs(id: string): Promise<Map<string, string>> {
    const rows = await this.#db.all<{ name: string; oid: string }>(
      "SELECT name, oid FROM git_native_ref WHERE repo = ?",
      id,
    )
    return new Map(rows.map((row) => [row.name, row.oid]))
  }

  async saveRefs(id: string, refs: ReadonlyMap<string, string>): Promise<void> {
    await this.#db.run("DELETE FROM git_native_ref WHERE repo = ?", id)
    for (const [name, oid] of refs)
      await this.#db.run("INSERT INTO git_native_ref (repo, name, oid) VALUES (?, ?, ?)", id, name, oid)
  }

  async shallow(id: string): Promise<Set<string>> {
    const rows = await this.#db.all<{ oid: string }>("SELECT oid FROM git_native_shallow WHERE repo = ?", id)
    return new Set(rows.map((row) => row.oid))
  }

  async saveShallow(id: string, oids: Iterable<string>): Promise<void> {
    await this.#db.run("DELETE FROM git_native_shallow WHERE repo = ?", id)
    for (const oid of oids) await this.#db.run("INSERT INTO git_native_shallow (repo, oid) VALUES (?, ?)", id, oid)
  }
}

/** A pack small enough to keep whole in the isolate, so a read inside it costs no R2 operation at all. */
export const WHOLE_PACK_BYTES = 2 * 1048576
const INDEX_CACHE = 8
const PACK_CACHE = 4

type Cached = { readonly index: PackIndex; readonly spans: Uint8Array; readonly packBytes: number }
const indexes = new Map<string, Cached>()
const packs = new Map<string, Uint8Array>()

const remember = <T>(map: Map<string, T>, key: string, value: T, limit: number): void => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value ?? "")
}

export type OpenedPack = { readonly index: PackIndex; readonly spans: Uint8Array; readonly source: ByteSource }

/** The pack, its index and its span table in R2, read by range so a cold read does not pull the whole pack. */
export class PackStore {
  readonly #bucket: R2Bucket

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket
  }

  #key(id: string, part: string): string {
    return `git-native/${id}/${part}`
  }

  async put(id: string, pack: Uint8Array, idx: Uint8Array, spans: Uint8Array): Promise<void> {
    await this.#bucket.put(this.#key(id, "pack"), pack)
    await this.#bucket.put(this.#key(id, "idx"), idx)
    await this.#bucket.put(this.#key(id, "spans"), spans)
    indexes.delete(id)
    packs.delete(id)
  }

  async open(id: string, packBytes: number): Promise<OpenedPack> {
    let cached = indexes.get(id)
    if (cached === undefined || cached.packBytes !== packBytes) {
      const idx = await this.#bucket.get(this.#key(id, "idx"))
      const spans = await this.#bucket.get(this.#key(id, "spans"))
      if (idx === null || spans === null) throw new Error("the pack index is missing")
      cached = {
        index: readIndex(new Uint8Array(await idx.arrayBuffer())),
        spans: new Uint8Array(await spans.arrayBuffer()),
        packBytes,
      }
      remember(indexes, id, cached, INDEX_CACHE)
    }
    return { index: cached.index, spans: cached.spans, source: this.#source(id, packBytes) }
  }

  async drop(id: string): Promise<void> {
    for (const part of ["pack", "idx", "spans"]) await this.#bucket.delete(this.#key(id, part))
    indexes.delete(id)
    packs.delete(id)
  }

  #source(id: string, packBytes: number): ByteSource {
    const key = this.#key(id, "pack")
    if (packBytes > WHOLE_PACK_BYTES) {
      return {
        length: packBytes,
        bytes: async (offset, length) => {
          const object = await this.#bucket.get(key, { range: { offset, length } })
          if (object === null) throw new Error("the pack is missing")
          return new Uint8Array(await object.arrayBuffer())
        },
      }
    }
    return {
      length: packBytes,
      bytes: async (offset, length) => {
        let whole = packs.get(id)
        if (whole === undefined) {
          const object = await this.#bucket.get(key)
          if (object === null) throw new Error("the pack is missing")
          whole = new Uint8Array(await object.arrayBuffer())
          remember(packs, id, whole, PACK_CACHE)
        }
        return whole.subarray(offset, offset + length)
      },
    }
  }
}
