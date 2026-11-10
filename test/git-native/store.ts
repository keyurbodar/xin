export type Store = {
  get(key: string): Promise<Uint8Array | undefined>
  put(key: string, value: Uint8Array): Promise<void>
  list(prefix: string): Promise<string[]>
}

export type Counters = {
  reads: number
  writes: number
  lists: number
  bytesRead: number
  bytesWritten: number
  fetches: number
  fetchBytes: number
}

export const zeroCounters = (): Counters => ({
  reads: 0,
  writes: 0,
  lists: 0,
  bytesRead: 0,
  bytesWritten: 0,
  fetches: 0,
  fetchBytes: 0,
})

export class CountingStore implements Store {
  readonly counters = zeroCounters()
  readonly inner: Store

  constructor(inner: Store) {
    this.inner = inner
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.counters.reads += 1
    const value = await this.inner.get(key)
    if (value !== undefined) this.counters.bytesRead += value.byteLength
    return value
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.counters.writes += 1
    this.counters.bytesWritten += value.byteLength
    await this.inner.put(key, value)
  }

  async list(prefix: string): Promise<string[]> {
    this.counters.lists += 1
    return this.inner.list(prefix)
  }
}

export class MemoryStore implements Store {
  readonly entries = new Map<string, Uint8Array>()

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.entries.get(key)
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.entries.set(key, value)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix)).toSorted()
  }
}

export class R2Store implements Store {
  readonly bucket: R2Bucket

  constructor(bucket: R2Bucket) {
    this.bucket = bucket
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.bucket.get(key)
    if (object === null) return undefined
    return new Uint8Array(await object.arrayBuffer())
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.bucket.put(key, value)
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await this.bucket.list(cursor === undefined ? { prefix } : { prefix, cursor })
      for (const object of page.objects) keys.push(object.key)
      if (!page.truncated) return keys
      cursor = page.cursor
    }
  }
}
