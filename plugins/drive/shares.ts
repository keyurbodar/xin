import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import type { FilesService } from "../../src/contracts/files.ts"
import { blobKey, toHex } from "../../src/r2env.ts"
import { shareKey } from "../../src/share.ts"

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: ["CREATE TABLE drive_shares (path TEXT PRIMARY KEY, id TEXT NOT NULL, at INTEGER NOT NULL)"],
  },
]

export type SharesPort = {
  readonly db: SqliteDatabase
  readonly bucket: R2Bucket
  readonly files: FilesService
}

export type Shares = {
  /** The link id of a shared path, or undefined. */
  idOf(path: string): Promise<string | undefined>
  /** Shares a file, or returns the id it already has. Undefined when the file is missing. */
  share(path: string): Promise<string | undefined>
  unshare(path: string): Promise<boolean>
  /** Moves a link to where its file went; the file's own change already dropped it at the old path. */
  carry(id: string, to: string): Promise<void>
  /** Keeps each link's manifest on its file's current bytes, and drops the link when the file goes. */
  changed(path: string): Promise<void>
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

export function createShares(port: SharesPort): Shares {
  let loaded: Promise<Map<string, string>> | undefined
  const byPath = (): Promise<Map<string, string>> => {
    loaded ??= port.db
      .all<{ path: string; id: string }>("SELECT path, id FROM drive_shares")
      .then((rows) => new Map(rows.map((row) => [row.path, row.id])))
    return loaded
  }

  const publish = async (path: string, id: string): Promise<boolean> => {
    const entry = await port.files.stat(path)
    if (entry === undefined) return false
    await port.bucket.put(
      shareKey(id),
      JSON.stringify({ key: blobKey(entry.sha256), type: entry.type, name: nameOf(path) }),
    )
    return true
  }

  const drop = async (path: string, id: string): Promise<void> => {
    await port.bucket.delete(shareKey(id))
    await port.db.run("DELETE FROM drive_shares WHERE path = ?", path)
    ;(await byPath()).delete(path)
  }

  const record = async (path: string, id: string): Promise<void> => {
    await port.db.run(
      "INSERT INTO drive_shares (path, id, at) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET id = excluded.id",
      path,
      id,
      Date.now(),
    )
    ;(await byPath()).set(path, id)
  }

  const refresh = async (path: string, id: string): Promise<void> => {
    if (!(await publish(path, id))) await drop(path, id)
  }

  return {
    idOf: async (path) => (await byPath()).get(path),
    share: async (path) => {
      const existing = (await byPath()).get(path)
      if (existing !== undefined) return existing
      const id = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer)
      if (!(await publish(path, id))) return undefined
      await record(path, id)
      return id
    },
    unshare: async (path) => {
      const id = (await byPath()).get(path)
      if (id === undefined) return false
      await drop(path, id)
      return true
    },
    carry: async (id, to) => {
      if (await publish(to, id)) await record(to, id)
    },
    changed: async (path) => {
      const shares = await byPath()
      if (shares.size === 0) return
      if (!path.endsWith("/")) {
        const id = shares.get(path)
        if (id !== undefined) await refresh(path, id)
        return
      }
      const under = [...shares].filter(([shared]) => shared.startsWith(path))
      for (const [shared, id] of under) await refresh(shared, id)
    },
  }
}
