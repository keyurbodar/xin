import type { Context } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  LineScanner,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  err,
  ok,
} from "@earendil-works/pi-durable/env"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CHUNK = 64 * 1024

export type FileRow = {
  readonly path: string
  readonly r2_key: string
  readonly size: number
  readonly type: string
  readonly sha256: string
  readonly project: string | null
  readonly updated_at: number
}

export type R2EnvOptions = {
  readonly cwd?: string
  readonly dirs?: Set<string>
}

const ROW_COLUMNS = "path, r2_key, size, type, sha256, project, updated_at"

const MIME: Readonly<Record<string, string>> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ts: "text/typescript",
  txt: "text/plain",
  webp: "image/webp",
}

export function normalizePath(cwd: string, path: string): string | undefined {
  const parts = `${path.startsWith("/") ? "" : cwd}/${path}`.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(part)
  }
  return `/${out.join("/")}`
}

export function resolvePath(cwd: string, path: string): string | undefined {
  return normalizePath(normalizePath("/", cwd) ?? "/", path)
}

export function typeOf(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot <= path.lastIndexOf("/")) return "application/octet-stream"
  return MIME[path.slice(dot + 1).toLowerCase()] ?? "application/octet-stream"
}

export function projectOf(path: string): string | null {
  const match = /^\/projects\/([^/]+)\//.exec(path)
  return match?.[1] ?? null
}

export function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then(toHex)
}

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function blobKey(sha: string): string {
  return `b/${sha}`
}

export type FileWrite = {
  readonly path: string
  readonly r2Key: string
  readonly size: number
  readonly type: string
  readonly sha256: string
}

export class FileIndex {
  constructor(private readonly db: SqliteDatabase) {}

  row(path: string): Promise<FileRow | undefined> {
    return this.db.get<FileRow>(`SELECT ${ROW_COLUMNS} FROM files WHERE path = ?`, path)
  }

  under(prefix: string): Promise<FileRow[]> {
    return this.db.all<FileRow>(
      `SELECT ${ROW_COLUMNS} FROM files WHERE substr(path, 1, ?) = ? ORDER BY path`,
      prefix.length,
      prefix,
    )
  }

  async hasUnder(prefix: string): Promise<boolean> {
    const row = await this.db.get<{ n: number }>(
      "SELECT 1 AS n FROM files WHERE substr(path, 1, ?) = ? LIMIT 1",
      prefix.length,
      prefix,
    )
    return row !== undefined
  }

  async referenced(r2Key: string): Promise<boolean> {
    const row = await this.db.get<{ n: number }>("SELECT 1 AS n FROM files WHERE r2_key = ? LIMIT 1", r2Key)
    return row !== undefined
  }

  async upsert(entry: FileWrite): Promise<FileRow> {
    const row = await this.db.get<FileRow>(
      `INSERT INTO files (path, r2_key, size, type, sha256, project, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET r2_key = excluded.r2_key, size = excluded.size, type = excluded.type, sha256 = excluded.sha256, project = excluded.project, updated_at = excluded.updated_at RETURNING ${ROW_COLUMNS}`,
      entry.path,
      entry.r2Key,
      entry.size,
      entry.type,
      entry.sha256,
      projectOf(entry.path),
      Date.now(),
    )
    if (row === undefined) throw new Error("files upsert returned no row")
    return row
  }

  async drop(path: string): Promise<boolean> {
    const rows = await this.db.all<{ path: string }>("DELETE FROM files WHERE path = ? RETURNING path", path)
    return rows.length > 0
  }

  async dropUnder(prefix: string): Promise<void> {
    await this.db.run("DELETE FROM files WHERE substr(path, 1, ?) = ?", prefix.length, prefix)
  }

  async move(from: string, to: string): Promise<void> {
    await this.db.run(
      "UPDATE files SET path = ?, project = ?, updated_at = ? WHERE path = ?",
      to,
      projectOf(to),
      Date.now(),
      from,
    )
  }
}

export async function putFile(
  bucket: R2Bucket,
  index: FileIndex,
  write: { readonly path: string; readonly content: string | Uint8Array },
): Promise<FileRow> {
  const bytes = typeof write.content === "string" ? encoder.encode(write.content) : write.content
  const digest = await sha256(bytes)
  await bucket.put(blobKey(digest), bytes)
  return index.upsert({
    path: write.path,
    r2Key: blobKey(digest),
    size: bytes.byteLength,
    type: typeOf(write.path),
    sha256: digest,
  })
}

function parentOf(path: string): string | undefined {
  if (path === "/") return undefined
  const index = path.lastIndexOf("/")
  return index <= 0 ? "/" : path.slice(0, index)
}

function nameOf(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1)
}

function aborted<T>(context: Context): Result<T, FileError> | undefined {
  return context.abortSignal?.aborted === true
    ? err<T, FileError>(new FileError("aborted", "operation aborted"))
    : undefined
}

function invalid<T>(message: string, path?: string): Result<T, FileError> {
  return err<T, FileError>(new FileError("invalid", message, path))
}

function directory(path: string, mtimeMs: number): FileInfo {
  return { name: nameOf(path), path, kind: "directory", size: 0, mtimeMs }
}

function file(row: FileRow): FileInfo {
  return { name: nameOf(row.path), path: row.path, kind: "file", size: row.size, mtimeMs: row.updated_at }
}

export class R2Env implements ExecutionEnv {
  readonly id = "owner"
  cwd: string
  readonly #dirs: Set<string>
  readonly #index: FileIndex

  constructor(
    private readonly bucket: R2Bucket,
    db: SqliteDatabase,
    options: R2EnvOptions = {},
  ) {
    this.cwd = normalizePath("/", options.cwd ?? "/") ?? "/"
    this.#dirs = options.dirs ?? new Set(["/"])
    this.#index = new FileIndex(db)
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#resolve(path, context)
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    const stop = aborted<string>(context)
    if (stop !== undefined) return stop
    const joined = normalizePath(this.cwd, parts.join("/"))
    return joined === undefined ? invalid("path escapes the files root", parts.join("/")) : ok(joined)
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#resolve(path, context)
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.#readFile(path, context)
    return bytes.ok ? ok(decoder.decode(bytes.value)) : bytes
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path, context)
    if (!text.ok) return text
    const lines = text.value.split("\n")
    if (text.value.endsWith("\n")) lines.pop()
    const limit = options?.maxLines
    return ok(limit === undefined ? lines : lines.slice(0, limit))
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const bytes = await this.#readFile(path, context)
    if (!bytes.ok) return bytes
    const text = decoder.decode(bytes.value)
    const lines = text.split("\n")
    const terminated = text.endsWith("\n")
    if (terminated) lines.pop()
    let index = 0
    let closed = false
    return ok({
      readLine: async (ctx) => {
        if (closed) return invalid("reader is closed", path)
        const stop = aborted<{ text: string; terminated: boolean }>(ctx)
        if (stop !== undefined) return stop
        if (index >= lines.length) return ok(undefined)
        const line = lines[index] ?? ""
        const last = index === lines.length - 1
        index++
        return ok({ text: line, terminated: !last || terminated })
      },
      close: async () => {
        closed = true
      },
    })
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.#readFile(path, context)
  }

  async openBinaryReader(
    path: string,
    _options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    const row = await this.#index.row(resolved.value)
    if (row === undefined) return this.#missing(resolved.value)
    const opened = resolved.value
    const size = row.size
    const mtimeMs = row.updated_at
    let closed = false
    const reader: BinaryReader = {
      info: async (ctx) => {
        if (closed) return invalid("reader is closed", opened)
        const stop = aborted<FileInfo>(ctx)
        if (stop !== undefined) return stop
        return ok({ name: nameOf(opened), path: opened, kind: "file", size, mtimeMs })
      },
      read: async (offset, length, ctx) => {
        if (closed) return invalid("reader is closed", opened)
        const stop = aborted<Uint8Array>(ctx)
        if (stop !== undefined) return stop
        if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0)
          return invalid("offset and length must be non-negative integers", opened)
        if (length === 0 || offset >= size) return ok(new Uint8Array())
        const object = await this.bucket.get(row.r2_key, { range: { offset, length: Math.min(length, size - offset) } })
        if (object === null) return err(new FileError("not_found", "bytes are missing from R2", opened))
        return ok(new Uint8Array(await object.arrayBuffer()))
      },
      scanLines: async (options, ctx) => {
        if (closed) return invalid("reader is closed", opened)
        const stop = aborted<LineScan>(ctx)
        if (stop !== undefined) return stop
        const { startLine, endLine } = options
        if (
          !Number.isInteger(startLine) ||
          startLine < 0 ||
          (endLine !== undefined && (!Number.isInteger(endLine) || endLine <= startLine))
        )
          return invalid("startLine and endLine must be non-negative integers with endLine > startLine", opened)
        const scanner = new LineScanner(startLine, endLine)
        for (let offset = 0; offset < size; offset += CHUNK) {
          const object = await this.bucket.get(row.r2_key, {
            range: { offset, length: Math.min(CHUNK, size - offset) },
          })
          if (object === null) return err(new FileError("not_found", "bytes are missing from R2", opened))
          scanner.push(new Uint8Array(await object.arrayBuffer()))
        }
        return ok(scanner.finish())
      },
      close: async () => {
        closed = true
      },
    }
    return ok(reader)
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    await putFile(this.bucket, this.#index, { path: resolved.value, content })
    return ok(undefined)
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const existing = await this.#readFile(path, context)
    if (!existing.ok) return existing
    const added = typeof content === "string" ? encoder.encode(content) : content
    const joined = new Uint8Array(existing.value.byteLength + added.byteLength)
    joined.set(existing.value)
    joined.set(added, existing.value.byteLength)
    return this.writeFile(path, joined, context)
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    if (!Number.isInteger(size) || size < 0) return invalid("size must be a non-negative integer", path)
    const existing = await this.#readFile(path, context)
    if (!existing.ok) return existing
    const bytes = new Uint8Array(size)
    bytes.set(existing.value.subarray(0, Math.min(size, existing.value.byteLength)))
    return this.writeFile(path, bytes, context)
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    return (await this.#index.row(resolved.value)) === undefined ? this.#missing(resolved.value) : ok(undefined)
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const source = this.#resolve(sourcePath, context)
    if (!source.ok) return source
    const destination = this.#resolve(destinationPath, context)
    if (!destination.ok) return destination
    const row = await this.#index.row(source.value)
    if (row === undefined) return this.#missing(source.value)
    if (await this.#isDir(destination.value))
      return err(new FileError("is_directory", "destination is a directory", destination.value))
    await this.#index.drop(destination.value)
    await this.#index.move(source.value, destination.value)
    return ok(undefined)
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    const row = await this.#index.row(resolved.value)
    if (row !== undefined) return ok(file(row))
    if (await this.#isDir(resolved.value)) return ok(directory(resolved.value, 0))
    return this.#missing(resolved.value)
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    const stop = aborted<FileInfo[]>(context)
    if (stop !== undefined) return stop
    if ((await this.#index.row(resolved.value)) !== undefined)
      return err(new FileError("not_directory", "not a directory", resolved.value))
    if (!(await this.#isDir(resolved.value))) return this.#missing(resolved.value)
    return ok(await this.#entries(resolved.value))
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    const stop = aborted<DirReader>(context)
    if (stop !== undefined) return stop
    if ((await this.#index.row(resolved.value)) !== undefined)
      return err(new FileError("not_directory", "not a directory", resolved.value))
    if (!(await this.#isDir(resolved.value))) return this.#missing(resolved.value)
    const opened = resolved.value
    let entries: FileInfo[] | undefined
    let index = 0
    let closed = false
    return ok({
      next: async (maxEntries, ctx) => {
        if (closed) return invalid("reader is closed", opened)
        if (!Number.isInteger(maxEntries) || maxEntries <= 0)
          return invalid("maxEntries must be a positive integer", opened)
        const stopped = aborted<{ entries: FileInfo[]; done: boolean }>(ctx)
        if (stopped !== undefined) return stopped
        entries ??= await this.#entries(opened)
        const page = entries.slice(index, index + maxEntries)
        index += page.length
        return ok({ entries: page, done: index >= entries.length })
      },
      close: async () => {
        closed = true
      },
    })
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    const stop = aborted<boolean>(context)
    if (stop !== undefined) return stop
    return ok((await this.#index.row(resolved.value)) !== undefined || (await this.#isDir(resolved.value)))
  }

  async createDir(
    path: string,
    _options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    if ((await this.#index.row(resolved.value)) !== undefined)
      return err(new FileError("not_directory", "a file exists at this path", resolved.value))
    this.#rememberDir(resolved.value)
    return ok(undefined)
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    const target = resolved.value
    if (await this.#index.drop(target)) return ok(undefined)
    if (await this.#isDir(target)) {
      const prefix = target === "/" ? "/" : `${target}/`
      const children = await this.#entries(target)
      if (children.length > 0 && options?.recursive !== true)
        return err(new FileError("invalid", "directory is not empty", target))
      await this.#index.dropUnder(prefix)
      for (const dir of this.#dirs) if (dir.startsWith(prefix)) this.#dirs.delete(dir)
      if (target !== "/") this.#dirs.delete(target)
      return ok(undefined)
    }
    return options?.force === true ? ok(undefined) : this.#missing(target)
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const stop = aborted<string>(context)
    if (stop !== undefined) return stop
    const path = `/${prefix ?? "tmp"}-${crypto.randomUUID()}`
    this.#rememberDir(path)
    return ok(path)
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const stop = aborted<string>(context)
    if (stop !== undefined) return stop
    const path = `/${options?.prefix ?? "tmp"}-${crypto.randomUUID()}${options?.suffix ?? ""}`
    const written = await this.writeFile(path, new Uint8Array(), context)
    return written.ok ? ok(path) : written
  }

  async cleanup(): Promise<void> {}

  async exec(
    _command: string | readonly string[],
    _options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted === true) return err(new ExecutionError("aborted", "operation aborted"))
    return err(new ExecutionError("shell_unavailable", "Xin runs files only, not code"))
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "R2 environments do not watch files"))
  }

  #resolve(path: string, context: Context): Result<string, FileError> {
    const stop = aborted<string>(context)
    if (stop !== undefined) return stop
    const absolute = resolvePath(this.cwd, path)
    return absolute === undefined ? invalid("path escapes the files root", path) : ok(absolute)
  }

  async #isDir(path: string): Promise<boolean> {
    return path === "/" || this.#dirs.has(path) || (await this.#index.hasUnder(path === "/" ? "/" : `${path}/`))
  }

  #rememberDir(path: string): void {
    let current: string | undefined = path
    while (current !== undefined) {
      this.#dirs.add(current)
      current = parentOf(current)
    }
  }

  async #missing<T>(path: string): Promise<Result<T, FileError>> {
    return (await this.#isDir(path))
      ? err<T, FileError>(new FileError("is_directory", "not a file", path))
      : err<T, FileError>(new FileError("not_found", "no such file", path))
  }

  async #readFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.#resolve(path, context)
    if (!resolved.ok) return resolved
    const row = await this.#index.row(resolved.value)
    if (row === undefined) return this.#missing(resolved.value)
    const object = await this.bucket.get(row.r2_key)
    if (object === null) return err(new FileError("not_found", "bytes are missing from R2", resolved.value))
    return ok(new Uint8Array(await object.arrayBuffer()))
  }

  async #entries(dir: string): Promise<FileInfo[]> {
    const prefix = dir === "/" ? "/" : `${dir}/`
    const found = new Map<string, FileInfo>()
    for (const row of await this.#index.under(prefix)) {
      const relative = row.path.slice(prefix.length)
      const slash = relative.indexOf("/")
      if (slash === -1) {
        found.set(row.path, file(row))
        continue
      }
      const child = `${dir === "/" ? "" : dir}/${relative.slice(0, slash)}`
      found.set(child, directory(child, 0))
    }
    for (const known of this.#dirs) {
      if (known === dir || !known.startsWith(prefix)) continue
      if (known.slice(prefix.length).includes("/")) continue
      found.set(known, directory(known, 0))
    }
    return [...found.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
}
