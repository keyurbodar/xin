import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"

export type ObjectKind = "commit" | "tree" | "blob" | "tag"

export type GitObject = { readonly kind: ObjectKind; readonly data: Uint8Array }

export type PackIndex = {
  readonly pack: Uint8Array
  readonly oids: readonly string[]
  readonly offsets: ReadonlyMap<string, number>
}

export type Sha1 = (data: Uint8Array) => Promise<string>

/** SHA-1 through Node's native binding, for the bench harness. A Worker passes `crypto.subtle` instead. */
export const nodeSha1: Sha1 = async (data) => createHash("sha1").update(data).digest("hex")

export const subtleSha1: Sha1 = async (data) => {
  const digest = await crypto.subtle.digest("SHA-1", data)
  let out = ""
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0")
  return out
}

const at = (data: Uint8Array, index: number): number => {
  const value = data[index]
  if (value === undefined) throw new Error(`object data ends at ${index}`)
  return value
}

const hex = (bytes: Uint8Array, offset: number): string => {
  let out = ""
  for (let i = 0; i < 20; i += 1)
    out += at(bytes, offset + i)
      .toString(16)
      .padStart(2, "0")
  return out
}

const KIND: Readonly<Record<number, ObjectKind | undefined>> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" }

const varint = (data: Uint8Array, start: number): { readonly value: number; readonly next: number } => {
  let value = 0
  let shift = 0
  let index = start
  for (;;) {
    const byte = at(data, index)
    index += 1
    value += (byte & 0x7f) * 2 ** shift
    shift += 7
    if ((byte & 0x80) === 0) return { value, next: index }
  }
}

export type Entry = {
  readonly offset: number
  readonly type: number
  readonly size: number
  readonly dataStart: number
  readonly compressed: number
  readonly baseOffset: number | undefined
  readonly baseOid: string | undefined
}

/** Reads every object header in one sequential pass, without inflating anything. */
export function scan(pack: Uint8Array): Entry[] {
  const entries: Entry[] = []
  const count = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8)
  let offset = 12
  for (let n = 0; n < count; n += 1) {
    let header = at(pack, offset)
    const type = (header >> 4) & 7
    let size = header & 0x0f
    let shift = 4
    let cursor = offset + 1
    while ((header & 0x80) !== 0) {
      header = at(pack, cursor)
      cursor += 1
      size += (header & 0x7f) * 2 ** shift
      shift += 7
    }
    let baseOffset: number | undefined
    let baseOid: string | undefined
    if (type === 6) {
      header = at(pack, cursor)
      cursor += 1
      let distance = header & 0x7f
      while ((header & 0x80) !== 0) {
        header = at(pack, cursor)
        cursor += 1
        distance = (distance + 1) * 128 + (header & 0x7f)
      }
      baseOffset = offset - distance
    } else if (type === 7) {
      baseOid = hex(pack, cursor)
      cursor += 20
    }
    const compressed = streamLength(pack, cursor)
    entries.push({ offset, type, size, dataStart: cursor, compressed, baseOffset, baseOid })
    offset = cursor + compressed
  }
  return entries
}

/** How many bytes of the pack a zlib stream occupies, without keeping its output. */
function streamLength(pack: Uint8Array, start: number): number {
  const result = inflateSync(pack.subarray(start), { info: true }) as unknown as {
    readonly engine?: { readonly bytesWritten?: number }
  }
  const written = result.engine?.bytesWritten
  if (written === undefined) throw new Error("zlib did not report the compressed length")
  return written
}

function inflate(data: Uint8Array, start: number, size: number, compressed: number): Uint8Array {
  if (size === 0) return new Uint8Array()
  // workerd's inflateSync fails with "Memory limit exceeded" for some `maxOutputLength` values, so the size is
  // checked afterwards instead of used as an allocation hint.
  const out = inflateSync(data.subarray(start, start + compressed))
  if (out.length !== size) throw new Error(`object at ${start} inflated to ${out.length} bytes, not ${size}`)
  return new Uint8Array(out)
}

function delta(base: Uint8Array, patch: Uint8Array): Uint8Array {
  const sourceSize = varint(patch, 0)
  const targetSize = varint(patch, sourceSize.next)
  const out = new Uint8Array(targetSize.value)
  let read = targetSize.next
  let write = 0
  while (read < patch.length) {
    const op = at(patch, read)
    read += 1
    if ((op & 0x80) === 0) {
      const length = op
      out.set(patch.subarray(read, read + length), write)
      read += length
      write += length
      continue
    }
    let offset = 0
    let length = 0
    for (let bit = 0; bit < 4; bit += 1) {
      if ((op & (1 << bit)) === 0) continue
      offset += at(patch, read) * 2 ** (8 * bit)
      read += 1
    }
    for (let bit = 0; bit < 3; bit += 1) {
      if ((op & (0x10 << bit)) === 0) continue
      length += at(patch, read) * 2 ** (8 * bit)
      read += 1
    }
    if (length === 0) length = 0x10000
    out.set(base.subarray(offset, offset + length), write)
    write += length
  }
  return out
}

export type ResolverOptions = {
  readonly keep?: (offset: number) => boolean
  /** Bytes of resolved base content to hold. A delta whose base was evicted is inflated again. */
  readonly budget?: number
  readonly oidAt?: (oid: string) => number | undefined
  /** Compressed length per object offset, so each inflate reads only its own bytes. */
  readonly spans?: ReadonlyMap<number, number>
}

/** Resolves objects out of a pack by offset, keeping only what a caller says it needs. */
export class Resolver {
  readonly pack: Uint8Array
  readonly #spans: ReadonlyMap<number, number>
  readonly #seen = new Map<number, GitObject>()
  readonly #keep: (offset: number) => boolean
  readonly #budget: number
  readonly #oidAt: (oid: string) => number | undefined
  #held = 0
  reinflated = 0

  constructor(pack: Uint8Array, options: ResolverOptions = {}) {
    this.pack = pack
    this.#keep = options.keep ?? (() => true)
    this.#spans = options.spans ?? new Map()
    this.#budget = options.budget ?? Number.POSITIVE_INFINITY
    this.#oidAt = options.oidAt ?? (() => undefined)
  }

  get held(): number {
    return this.#held
  }

  object(offset: number): GitObject {
    const cached = this.#seen.get(offset)
    if (cached !== undefined) return cached
    const { pack } = this
    let header = at(pack, offset)
    const type = (header >> 4) & 7
    let size = header & 0x0f
    let shift = 4
    let cursor = offset + 1
    while ((header & 0x80) !== 0) {
      header = at(pack, cursor)
      cursor += 1
      size += (header & 0x7f) * 2 ** shift
      shift += 7
    }
    const kind = KIND[type]
    let object: GitObject
    if (kind !== undefined) {
      object = { kind, data: inflate(pack, cursor, size, this.#spans.get(offset) ?? pack.length - cursor) }
    } else if (type === 6) {
      let base = at(pack, cursor)
      cursor += 1
      let distance = base & 0x7f
      while ((base & 0x80) !== 0) {
        base = at(pack, cursor)
        cursor += 1
        distance = (distance + 1) * 128 + (base & 0x7f)
      }
      const parent = this.object(offset - distance)
      object = {
        kind: parent.kind,
        data: delta(parent.data, inflate(pack, cursor, size, this.#spans.get(offset) ?? pack.length - cursor)),
      }
    } else if (type === 7) {
      const baseOid = hex(pack, cursor)
      const baseOffset = this.#oidAt(baseOid)
      if (baseOffset === undefined) throw new Error(`delta base ${baseOid} is not in this pack`)
      const parent = this.object(baseOffset)
      object = {
        kind: parent.kind,
        data: delta(parent.data, inflate(pack, cursor + 20, size, this.#spans.get(offset) ?? pack.length - cursor)),
      }
    } else {
      throw new Error(`pack object type ${type} is not supported`)
    }
    if (this.#keep(offset)) {
      if (this.#seen.has(offset)) this.reinflated += 1
      this.#seen.set(offset, object)
      this.#held += object.data.length
      for (const [key, value] of this.#seen) {
        if (this.#held <= this.#budget) break
        this.#seen.delete(key)
        this.#held -= value.data.length
      }
    }
    return object
  }
}

/** The v2 `.idx` next to a pack: a fanout, the sorted object ids, and each object's offset in the pack. */
export function readIndex(pack: Uint8Array, idx: Uint8Array): PackIndex {
  if (at(idx, 0) !== 0xff || at(idx, 1) !== 0x74 || at(idx, 2) !== 0x4f || at(idx, 3) !== 0x63) {
    throw new Error("only a v2 pack index is supported")
  }
  const view = new DataView(idx.buffer, idx.byteOffset, idx.byteLength)
  const count = view.getUint32(8 + 255 * 4)
  const oidBase = 8 + 256 * 4
  const offsetBase = oidBase + count * 20 + count * 4
  const largeBase = offsetBase + count * 4
  const oids: string[] = []
  const offsets = new Map<string, number>()
  for (let i = 0; i < count; i += 1) {
    const oid = hex(idx, oidBase + i * 20)
    const raw = view.getUint32(offsetBase + i * 4)
    const large = largeBase + (raw - 0x80000000) * 8
    const offset = raw >= 0x80000000 ? view.getUint32(large) * 0x100000000 + view.getUint32(large + 4) : raw
    oids.push(oid)
    offsets.set(oid, offset)
  }
  return { pack, oids, offsets }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array, from: number, to: number): number {
  let crc = 0xffffffff
  for (let i = from; i < to; i += 1) crc = (CRC_TABLE[(crc ^ at(data, i)) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export type BuiltIndex = {
  readonly index: PackIndex
  readonly idx: Uint8Array
  readonly hashed: number
  readonly peakRetainedBytes: number
  readonly reinflated: number
}

/**
 * Builds a git-format `.idx` from a pack in one sweep, hashing each object once. Only objects another object is
 * deltified against are kept, so a large pack does not have to be held inflated in memory.
 */
export async function buildIndex(
  pack: Uint8Array,
  sha1: Sha1,
  budget = Number.POSITIVE_INFINITY,
  limit = Number.POSITIVE_INFINITY,
): Promise<BuiltIndex> {
  const all = scan(pack)
  const entries = all.slice(0, limit)
  const offsets = new Map<number, number>()
  const bases = new Set<number>()
  for (const entry of entries) {
    offsets.set(entry.offset, entry.dataStart)
    if (entry.baseOffset !== undefined) bases.add(entry.baseOffset)
  }
  const oidAt = (oid: string): number | undefined => byOid.get(oid)
  const byOid = new Map<string, number>()
  const spans = new Map(entries.map((entry) => [entry.offset, entry.compressed]))
  const resolver = new Resolver(pack, { keep: (offset) => bases.has(offset), budget, oidAt, spans })
  const rows: { oid: string; offset: number; crc: number }[] = []
  const pending: Entry[] = []
  const endOf = new Map(all.map((entry, index) => [entry.offset, all[index + 1]?.offset ?? pack.length - 20]))
  const hash = async (entry: Entry): Promise<void> => {
    const object = resolver.object(entry.offset)
    const header = new TextEncoder().encode(`${object.kind} ${object.data.length}\u0000`)
    const joined = new Uint8Array(header.length + object.data.length)
    joined.set(header)
    joined.set(object.data, header.length)
    const oid = await sha1(joined)
    byOid.set(oid, entry.offset)
    rows.push({
      oid,
      offset: entry.offset,
      crc: crc32(pack, entry.offset, endOf.get(entry.offset) ?? pack.length - 20),
    })
  }
  for (const entry of entries) {
    if (entry.baseOid !== undefined && byOid.get(entry.baseOid) === undefined) pending.push(entry)
    else await hash(entry)
  }
  for (let pass = 0; pending.length > 0; pass += 1) {
    if (pass > 4) throw new Error(`${pending.length} objects have delta bases that are not in this pack`)
    const still = pending.splice(0)
    for (const entry of still) {
      if (entry.baseOid !== undefined && byOid.get(entry.baseOid) === undefined) pending.push(entry)
      else await hash(entry)
    }
  }
  rows.sort((left, right) => (left.oid < right.oid ? -1 : 1))
  const idx = writeIndex(pack, rows)
  const sorted = new Map(rows.map((row) => [row.oid, row.offset]))
  return {
    index: { pack, oids: rows.map((row) => row.oid), offsets: sorted },
    idx,
    hashed: rows.length,
    peakRetainedBytes: resolver.held,
    reinflated: resolver.reinflated,
  }
}

function writeIndex(pack: Uint8Array, rows: readonly { oid: string; offset: number; crc: number }[]): Uint8Array {
  const count = rows.length
  const bytes = new Uint8Array(8 + 256 * 4 + count * 28 + 40)
  const view = new DataView(bytes.buffer)
  bytes.set([0xff, 0x74, 0x4f, 0x63], 0)
  view.setUint32(4, 2)
  const fanout = new Uint32Array(256)
  for (const row of rows) {
    const bucket = Number.parseInt(row.oid.slice(0, 2), 16)
    fanout[bucket] = (fanout[bucket] ?? 0) + 1
  }
  let running = 0
  for (let i = 0; i < 256; i += 1) {
    running += fanout[i] ?? 0
    view.setUint32(8 + i * 4, running)
  }
  const oidBase = 8 + 256 * 4
  const crcBase = oidBase + count * 20
  const offsetBase = crcBase + count * 4
  for (let i = 0; i < count; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    for (let b = 0; b < 20; b += 1) bytes[oidBase + i * 20 + b] = Number.parseInt(row.oid.slice(b * 2, b * 2 + 2), 16)
    view.setUint32(crcBase + i * 4, row.crc)
    view.setUint32(offsetBase + i * 4, row.offset)
  }
  bytes.set(pack.subarray(pack.length - 20), offsetBase + count * 4)
  const digest = createHash("sha1")
    .update(bytes.subarray(0, bytes.length - 20))
    .digest()
  bytes.set(new Uint8Array(digest.buffer, digest.byteOffset, 20), bytes.length - 20)
  return bytes
}

export class PackReader {
  readonly index: PackIndex
  readonly #resolver: Resolver

  constructor(index: PackIndex) {
    this.index = index
    this.#resolver = new Resolver(index.pack, { oidAt: (oid) => index.offsets.get(oid) })
  }

  get size(): number {
    return this.index.oids.length
  }

  read(oid: string): GitObject {
    const offset = this.index.offsets.get(oid)
    if (offset === undefined) throw new Error(`object ${oid} is not in this pack`)
    return this.#resolver.object(offset)
  }
}
