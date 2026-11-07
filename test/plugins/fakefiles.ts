import type { Context } from "@deepseek-ai/cordis"
import type { EnvTarget } from "@earendil-works/pi-durable"
import {
  type BinaryReader,
  type DirReader,
  err,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  ok,
  type Result,
  type ShellExecResult,
  type TextLineReader,
} from "@earendil-works/pi-durable/env"
import type { FileEntry, FilesService } from "../../src/contracts/files.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Stored = { readonly bytes: Uint8Array; readonly mtimeMs: number }

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const missing = (path: string): FileError => new FileError("not_found", `no such file: ${path}`, path)

const unsupported = (what: string): FileError => new FileError("not_supported", `${what} is not supported here`)

function infoOf(path: string, file: Stored): FileInfo {
  return { name: nameOf(path), path, kind: "file", size: file.bytes.length, mtimeMs: file.mtimeMs }
}

const toBytes = (content: string | Uint8Array): Uint8Array =>
  typeof content === "string" ? encoder.encode(content) : content

class MemoryReader implements BinaryReader {
  constructor(
    private readonly path: string,
    private readonly file: Stored,
  ) {}

  async info(): Promise<Result<FileInfo, FileError>> {
    return ok(infoOf(this.path, this.file))
  }

  async read(offset: number, length: number): Promise<Result<Uint8Array, FileError>> {
    const start = Math.min(Math.max(offset, 0), this.file.bytes.length)
    return ok(this.file.bytes.subarray(start, Math.min(start + length, this.file.bytes.length)))
  }

  async scanLines(options: { startLine: number; endLine?: number }): Promise<Result<LineScan, FileError>> {
    const bytes = this.file.bytes
    const newlines: number[] = []
    for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0x0a) newlines.push(index)
    const lineCount = newlines.length + 1
    const lineStart = (line: number): number =>
      line <= 0 ? 0 : line - 1 < newlines.length ? (newlines[line - 1] ?? 0) + 1 : bytes.length
    const lineEnd = (line: number): number => (line < newlines.length ? (newlines[line] ?? bytes.length) : bytes.length)
    const first = Math.min(options.startLine, lineCount)
    const after = options.endLine === undefined ? lineCount : Math.min(options.endLine, lineCount)
    const start = lineStart(first)
    const end = after <= first ? start : lineEnd(after - 1)
    const firstLineEnd = first >= lineCount ? bytes.length : lineEnd(first)
    return ok({
      newlines: newlines.length,
      start,
      end,
      firstLineEnd,
      lastLineStart: after <= first ? start : lineStart(after - 1),
      selectedBytes: end - start,
      firstLineBytes: first >= lineCount ? 0 : firstLineEnd - start,
    })
  }

  async close(): Promise<void> {}
}

class MemoryEnv implements ExecutionEnv {
  readonly id = "fake-files"
  cwd: string

  constructor(
    private readonly store: MemoryStore,
    cwd: string,
  ) {
    this.cwd = cwd
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.store.resolve(this.cwd, path))
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(normalize(parts.join("/")))
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    return ok(normalize(path))
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    return ok(this.store.info(normalize(path)) !== undefined)
  }

  async readTextFile(path: string): Promise<Result<string, FileError>> {
    const key = normalize(path)
    const file = this.store.files.get(key)
    return file === undefined ? err(missing(key)) : ok(decoder.decode(file.bytes))
  }

  async openTextLineReader(): Promise<Result<TextLineReader, FileError>> {
    return err(unsupported("openTextLineReader"))
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined): Promise<Result<string[], FileError>> {
    const key = normalize(path)
    const file = this.store.files.get(key)
    if (file === undefined) return err(missing(key))
    const text = decoder.decode(file.bytes)
    const lines = text === "" ? [] : text.split("\n")
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines))
  }

  async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    const key = normalize(path)
    const file = this.store.files.get(key)
    return file === undefined ? err(missing(key)) : ok(new Uint8Array(file.bytes))
  }

  async openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> {
    const key = normalize(path)
    if (this.store.dirs.has(key)) return err(new FileError("is_directory", `${key} is a directory`, key))
    const file = this.store.files.get(key)
    return file === undefined ? err(missing(key)) : ok(new MemoryReader(key, file))
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    this.store.write(normalize(path), toBytes(content))
    return ok(undefined)
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const key = normalize(path)
    const previous = this.store.files.get(key)?.bytes ?? new Uint8Array()
    const next = toBytes(content)
    const bytes = new Uint8Array(previous.length + next.length)
    bytes.set(previous)
    bytes.set(next, previous.length)
    this.store.write(key, bytes)
    return ok(undefined)
  }

  async truncateFile(path: string, size: number): Promise<Result<void, FileError>> {
    const key = normalize(path)
    const previous = this.store.files.get(key)?.bytes ?? new Uint8Array()
    const bytes = new Uint8Array(size)
    bytes.set(previous.subarray(0, size))
    this.store.write(key, bytes)
    return ok(undefined)
  }

  async flushFile(): Promise<Result<void, FileError>> {
    return ok(undefined)
  }

  async renameFile(source: string, destination: string): Promise<Result<void, FileError>> {
    const from = normalize(source)
    const to = normalize(destination)
    const file = this.store.files.get(from)
    if (file === undefined) return err(missing(from))
    this.store.files.delete(from)
    this.store.write(to, file.bytes)
    return ok(undefined)
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const key = normalize(path)
    const info = this.store.info(key)
    return info === undefined ? err(missing(key)) : ok(info)
  }

  async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    const key = normalize(path)
    if (!this.store.dirs.has(key)) return err(missing(key))
    const entries: FileInfo[] = []
    for (const candidate of this.store.children(key)) {
      const info = this.store.info(candidate)
      if (info !== undefined) entries.push(info)
    }
    return ok(entries)
  }

  async openDirReader(): Promise<Result<DirReader, FileError>> {
    return err(unsupported("openDirReader"))
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(unsupported("watch"))
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined): Promise<Result<void, FileError>> {
    const key = normalize(path)
    this.store.dirs.add(key)
    if (options?.recursive === true) this.store.makeParents(key)
    return ok(undefined)
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
  ): Promise<Result<void, FileError>> {
    const key = normalize(path)
    const removed = this.store.remove(key, options?.recursive === true)
    return removed || options?.force === true ? ok(undefined) : err(missing(key))
  }

  async createTempDir(prefix: string | undefined): Promise<Result<string, FileError>> {
    const path = `/tmp/${prefix ?? "fake"}-${this.store.temp()}`
    this.store.dirs.add(path)
    return ok(path)
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined): Promise<Result<string, FileError>> {
    const path = `/tmp/${options?.prefix ?? "fake"}-${this.store.temp()}${options?.suffix ?? ""}`
    this.store.write(path, new Uint8Array())
    return ok(path)
  }

  async cleanup(): Promise<void> {}

  async exec(): Promise<Result<ShellExecResult, ExecutionError>> {
    return err(new ExecutionError("shell_unavailable", "the fake files service runs no commands"))
  }
}

class MemoryStore {
  readonly files = new Map<string, Stored>()
  readonly dirs = new Set<string>(["/"])
  #clock = 0
  #temps = 0

  resolve(cwd: string, path: string): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`)
  }

  write(path: string, bytes: Uint8Array): void {
    this.files.set(path, { bytes, mtimeMs: ++this.#clock })
    this.makeParents(path)
  }

  makeParents(path: string): void {
    const parts = path.split("/").filter((part) => part !== "")
    for (let index = 1; index < parts.length; index += 1) this.dirs.add(`/${parts.slice(0, index).join("/")}`)
  }

  info(path: string): FileInfo | undefined {
    const file = this.files.get(path)
    if (file !== undefined) return infoOf(path, file)
    if (this.dirs.has(path)) return { name: nameOf(path) || "/", path, kind: "directory", size: 0, mtimeMs: 0 }
    return undefined
  }

  fileOf(path: string): Stored {
    const file = this.files.get(path)
    if (file === undefined) throw new Error(`the fake store lost ${path}`)
    return file
  }

  children(dir: string): string[] {
    const prefix = dir === "/" ? "/" : `${dir}/`
    const names = new Set<string>()
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (!path.startsWith(prefix) || path === dir) continue
      const rest = path.slice(prefix.length)
      names.add(`${prefix}${rest.split("/")[0] ?? rest}`)
    }
    return [...names]
  }

  remove(path: string, recursive: boolean): boolean {
    if (this.files.delete(path)) return true
    if (!this.dirs.has(path)) return false
    if (!recursive) {
      if (this.children(path).length > 0) return false
      return this.dirs.delete(path)
    }
    for (const candidate of this.files.keys()) if (candidate.startsWith(`${path}/`)) this.files.delete(candidate)
    for (const candidate of this.dirs) if (candidate.startsWith(`${path}/`)) this.dirs.delete(candidate)
    return this.dirs.delete(path)
  }

  temp(): number {
    this.#temps += 1
    return this.#temps
  }
}

async function entryOf(path: string, file: Stored): Promise<FileEntry> {
  const digest = await crypto.subtle.digest("SHA-256", file.bytes)
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return {
    path,
    size: file.bytes.length,
    type: "text/plain",
    sha256,
    project: null,
    updated_at: file.mtimeMs,
  }
}

function createFiles(store: MemoryStore): FilesService {
  return {
    env: (target: EnvTarget) => new MemoryEnv(store, target.cwd ?? "/"),
    list: async (prefix) => {
      const base = normalize(prefix ?? "/")
      const paths = [...store.files.keys()].filter((path) => path.startsWith(base === "/" ? "/" : `${base}/`))
      return Promise.all(paths.map((path) => entryOf(path, store.fileOf(path))))
    },
    read: async (path) => {
      const file = store.files.get(normalize(path))
      return file === undefined ? undefined : decoder.decode(file.bytes)
    },
    stat: async (path) => {
      const key = normalize(path)
      const file = store.files.get(key)
      return file === undefined ? undefined : entryOf(key, file)
    },
    write: async (path, text) => {
      const key = normalize(path)
      store.write(key, encoder.encode(text))
      return entryOf(key, store.fileOf(key))
    },
    remove: async (path) => store.files.delete(normalize(path)),
  }
}

const fakeFiles = {
  name: "fake-files",
  apply(ctx: Context): void {
    const store = new MemoryStore()
    ctx.provide("files", createFiles(store))
  },
}

export const catalog: Catalog = {
  "fake-files": {
    plugin: fakeFiles,
    title: "Fake in-memory files",
    description: "An in-memory files service for testing that a different row can provide the files seam.",
    source: "test",
  },
}
