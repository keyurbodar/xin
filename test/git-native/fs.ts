const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Options = string | { readonly encoding?: string } | undefined

const asText = (value: string | Uint8Array, options: Options): string | Uint8Array => {
  const encoding = typeof options === "string" ? options : options?.encoding
  return encoding === undefined || encoding === null ? value : typeof value === "string" ? value : decoder.decode(value)
}

const toBytes = (value: string | Uint8Array, options: Options): Uint8Array =>
  typeof value === "string" ? encoder.encode(asText(value, options) as string) : value

const parentOf = (path: string): string => {
  const cut = path.lastIndexOf("/")
  return cut <= 0 ? "/" : path.slice(0, cut)
}

const join = (base: string, name: string): string => (base === "/" ? `/${name}` : `${base}/${name}`)

export type Stat = {
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
  readonly size: number
  readonly mode: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly uid: number
  readonly gid: number
  readonly ino: number
  readonly dev: number
}

const statOf = (kind: "file" | "dir", size: number): Stat => ({
  isFile: () => kind === "file",
  isDirectory: () => kind === "dir",
  isSymbolicLink: () => false,
  size,
  mode: kind === "dir" ? 0o40755 : 0o100644,
  mtimeMs: 0,
  ctimeMs: 0,
  uid: 0,
  gid: 0,
  ino: 0,
  dev: 0,
})

const missing = (path: string): Error => {
  const error = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string }
  error.code = "ENOENT"
  return error
}

/** The subset of a promise-based `fs` that isomorphic-git calls, held in memory. */
export class MemFS {
  readonly files = new Map<string, Uint8Array>()
  readonly dirs = new Set<string>(["/"])
  readonly #hooks = new Map<string, (path: string) => Promise<Uint8Array | undefined>>()

  /** Answer reads under `prefix` from `load` instead of memory, so an object store can stay lazy. */
  onMiss(prefix: string, load: (path: string) => Promise<Uint8Array | undefined>): void {
    this.#hooks.set(prefix, load)
  }

  write(path: string, value: string | Uint8Array): void {
    const parts = path.split("/").filter((part) => part !== "")
    let dir = "/"
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part)
      this.dirs.add(dir)
    }
    this.files.set(path, toBytes(value, undefined))
  }

  paths(): string[] {
    return [...this.files.keys()].toSorted()
  }

  async readFile(path: string, options?: Options): Promise<string | Uint8Array> {
    const hit = this.files.get(path)
    if (hit !== undefined) return asText(hit, options)
    for (const [prefix, load] of this.#hooks) {
      if (!path.startsWith(prefix)) continue
      const loaded = await load(path)
      if (loaded === undefined) continue
      this.files.set(path, loaded)
      return asText(loaded, options)
    }
    throw missing(path)
  }

  async writeFile(path: string, value: string | Uint8Array, options?: Options): Promise<void> {
    this.write(path, typeof value === "string" ? (asText(value, options) as string) : value)
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw missing(path)
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) throw missing(path)
    const names = new Set<string>()
    for (const file of this.files.keys())
      if (parentOf(file) === path) names.add(file.slice(path === "/" ? 1 : path.length + 1))
    for (const dir of this.dirs)
      if (dir !== path && parentOf(dir) === path) names.add(dir.slice(path === "/" ? 1 : path.length + 1))
    return [...names]
  }

  async mkdir(path: string): Promise<void> {
    const parts = path.split("/").filter((part) => part !== "")
    let dir = "/"
    for (const part of parts) {
      dir = join(dir, part)
      this.dirs.add(dir)
    }
  }

  async rmdir(path: string): Promise<void> {
    if (!this.dirs.delete(path)) throw missing(path)
  }

  async stat(path: string): Promise<Stat> {
    const file = this.files.get(path)
    if (file !== undefined) return statOf("file", file.length)
    if (this.dirs.has(path)) return statOf("dir", 0)
    for (const [prefix, load] of this.#hooks) {
      if (!path.startsWith(prefix)) continue
      const loaded = await load(path)
      if (loaded === undefined) continue
      this.files.set(path, loaded)
      return statOf("file", loaded.length)
    }
    throw missing(path)
  }

  async lstat(path: string): Promise<Stat> {
    return this.stat(path)
  }

  async readlink(): Promise<string> {
    throw new Error("ENOSYS: readlink is not supported")
  }

  async symlink(target: string, path: string): Promise<void> {
    this.write(path, target)
  }

  async chmod(): Promise<void> {}
}
