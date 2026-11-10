import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"

export type ObjectKind = "commit" | "tree" | "blob" | "tag"

export type GitObject = { readonly kind: ObjectKind; readonly data: Uint8Array }

export type PackIndex = {
  readonly oids: readonly string[]
  readonly offsets: ReadonlyMap<string, number>
}

/** Random access to a pack's bytes, so a read can pull one object instead of the whole file. */
export type ByteSource = {
  readonly length: number
  bytes(offset: number, length: number): Promise<Uint8Array>
}

export const memorySource = (pack: Uint8Array): ByteSource => ({
  length: pack.byteLength,
  bytes: async (offset, length) => pack.subarray(offset, offset + length),
})

export type Sha1 = (data: Uint8Array) => Promise<string>

/** SHA-1 through Node's binding, for scripts and tests. A Worker passes `crypto.subtle` instead. */
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

export const PACK_HEADER = 12
export const PACK_TRAILER = 20

/** How many bytes of the pack a zlib stream occupies, without keeping its output. */
function streamLength(pack: Uint8Array, start: number): number {
  const result = inflateSync(pack.subarray(start), { info: true }) as unknown as {
    readonly engine?: { readonly bytesWritten?: number }
  }
  const written = result.engine?.bytesWritten
  if (written === undefined) throw new Error("zlib did not report the compressed length")
  return written
}

/** Reads every object header in one sequential pass, without keeping any object. */
export function scan(pack: Uint8Array): Entry[] {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength)
  if (view.getUint32(0) !== 0x5041434b) throw new Error("not a git packfile")
  const count = view.getUint32(8)
  const entries: Entry[] = []
  let offset = PACK_HEADER
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
      let base = at(pack, cursor)
      cursor += 1
      let distance = base & 0x7f
      while ((base & 0x80) !== 0) {
        base = at(pack, cursor)
        cursor += 1
        distance = (distance + 1) * 128 + (base & 0x7f)
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

export function inflateObject(data: Uint8Array, size: number): Uint8Array {
  if (size === 0) return new Uint8Array()
  // workerd's inflateSync fails with "Memory limit exceeded" for some `maxOutputLength` values, so the length is
  // checked afterwards instead of used as an allocation hint.
  const out = inflateSync(data)
  if (out.length !== size) throw new Error(`object inflated to ${out.length} bytes, not ${size}`)
  return new Uint8Array(out)
}

export function applyDelta(base: Uint8Array, patch: Uint8Array): Uint8Array {
  const sourceSize = varint(patch, 0)
  if (sourceSize.value !== base.length) throw new Error("delta base is the wrong size")
  const targetSize = varint(patch, sourceSize.next)
  const out = new Uint8Array(targetSize.value)
  let read = targetSize.next
  let write = 0
  while (read < patch.length) {
    const op = at(patch, read)
    read += 1
    if ((op & 0x80) === 0) {
      out.set(patch.subarray(read, read + op), write)
      read += op
      write += op
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
  if (write !== out.length) throw new Error("delta did not fill its target")
  return out
}

/** The v2 `.idx` next to a pack: a fanout, the sorted object ids, and each object's offset in the pack. */
export function readIndex(idx: Uint8Array): PackIndex {
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
  return { oids, offsets }
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
  /** Eight bytes per object in index order: its offset, then the bytes it occupies. */
  readonly spans: Uint8Array
  readonly idx: Uint8Array
  readonly hashed: number
  readonly retainedBytes: number
}

const SPAN_BYTES = 8

/** Where one object sits in the pack: its offset, and the bytes it occupies including its own header. */
export function spanAt(spans: Uint8Array, position: number): { readonly offset: number; readonly length: number } {
  const view = new DataView(spans.buffer, spans.byteOffset, spans.byteLength)
  return { offset: view.getUint32(position * SPAN_BYTES), length: view.getUint32(position * SPAN_BYTES + 4) }
}

/**
 * Builds a git-format `.idx` and the span table from a pack in one sweep, hashing each object once. Only objects
 * another object is deltified against are kept, so a large pack is not held inflated in memory.
 */
export async function buildIndex(pack: Uint8Array, sha1: Sha1, baseBudget = 8 * 1048576): Promise<BuiltIndex> {
  const entries = scan(pack)
  const endOf = new Map(
    entries.map((entry, index) => [entry.offset, entries[index + 1]?.offset ?? pack.length - PACK_TRAILER]),
  )
  const bases = new Set<number>()
  for (const entry of entries) if (entry.baseOffset !== undefined) bases.add(entry.baseOffset)
  const byOffset = new Map(entries.map((entry, index) => [entry.offset, index]))
  const held = new Map<number, GitObject>()
  let heldBytes = 0
  const byOid = new Map<string, number>()

  const resolve = async (offset: number): Promise<GitObject> => {
    const cached = held.get(offset)
    if (cached !== undefined) return cached
    const position = byOffset.get(offset)
    const entry = position === undefined ? undefined : entries[position]
    if (entry === undefined) throw new Error(`no object at ${offset} in this pack`)
    const raw = pack.subarray(entry.dataStart, entry.dataStart + entry.compressed)
    const kind = KIND[entry.type]
    let object: GitObject
    if (kind !== undefined) {
      object = { kind, data: inflateObject(raw, entry.size) }
    } else if (entry.type === 6 && entry.baseOffset !== undefined) {
      const base = await resolve(entry.baseOffset)
      object = { kind: base.kind, data: applyDelta(base.data, inflateObject(raw, entry.size)) }
    } else if (entry.type === 7 && entry.baseOid !== undefined) {
      const baseOffset = byOid.get(entry.baseOid)
      if (baseOffset === undefined) throw new Error(`delta base ${entry.baseOid} is not in this pack`)
      const base = await resolve(baseOffset)
      object = { kind: base.kind, data: applyDelta(base.data, inflateObject(raw, entry.size)) }
    } else {
      throw new Error(`pack object type ${entry.type} is not supported`)
    }
    if (bases.has(offset)) {
      held.set(offset, object)
      heldBytes += object.data.length
      for (const [key, value] of held) {
        if (heldBytes <= baseBudget) break
        held.delete(key)
        heldBytes -= value.data.length
      }
    }
    return object
  }

  const rows: { oid: string; offset: number; crc: number }[] = []
  const pending: Entry[] = []
  const hash = async (entry: Entry): Promise<void> => {
    const object = await resolve(entry.offset)
    const header = new TextEncoder().encode(`${object.kind} ${object.data.length}\u0000`)
    const joined = new Uint8Array(header.length + object.data.length)
    joined.set(header)
    joined.set(object.data, header.length)
    const oid = await sha1(joined)
    byOid.set(oid, entry.offset)
    rows.push({
      oid,
      offset: entry.offset,
      crc: crc32(pack, entry.offset, endOf.get(entry.offset) ?? pack.length - PACK_TRAILER),
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
  const spans = new Uint8Array(rows.length * SPAN_BYTES)
  const spanView = new DataView(spans.buffer)
  for (let position = 0; position < rows.length; position += 1) {
    const row = rows[position]
    if (row === undefined) continue
    const entry = entries[byOffset.get(row.offset) ?? -1]
    if (entry === undefined) continue
    spanView.setUint32(position * SPAN_BYTES, entry.offset)
    spanView.setUint32(position * SPAN_BYTES + 4, entry.dataStart - entry.offset + entry.compressed)
  }
  return {
    index: { oids: rows.map((row) => row.oid), offsets: new Map(rows.map((row) => [row.oid, row.offset])) },
    spans,
    idx,
    hashed: rows.length,
    retainedBytes: heldBytes,
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
  bytes.set(pack.subarray(pack.length - PACK_TRAILER), offsetBase + count * 4)
  const digest = sha1Bytes(bytes.subarray(0, bytes.length - PACK_TRAILER))
  bytes.set(digest, bytes.length - PACK_TRAILER)
  return bytes
}

function sha1Bytes(data: Uint8Array): Uint8Array {
  const digest = createHash("sha1").update(data).digest()
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength)
}
