import { applyDelta, type ByteSource, type GitObject, inflateObject, type PackIndex, spanAt } from "./pack.ts"

const KIND: Readonly<Record<number, GitObject["kind"] | undefined>> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" }

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

/** Reads objects out of a stored pack, one object at a time, through whatever byte source the store offers. */
export class PackObjects {
  readonly index: PackIndex
  readonly #spans: Uint8Array
  readonly #source: ByteSource
  readonly #seen = new Map<string, GitObject>()
  #byOffset: Map<number, number> | undefined

  constructor(index: PackIndex, spans: Uint8Array, source: ByteSource) {
    this.index = index
    this.#spans = spans
    this.#source = source
  }

  has(oid: string): boolean {
    return this.index.offsets.has(oid)
  }

  get size(): number {
    return this.index.oids.length
  }

  async read(oid: string): Promise<GitObject> {
    const cached = this.#seen.get(oid)
    if (cached !== undefined) return cached
    const offset = this.index.offsets.get(oid)
    if (offset === undefined) throw new Error(`object ${oid} is not in this pack`)
    const object = await this.#object(offset)
    this.#seen.set(oid, object)
    return object
  }

  async text(oid: string): Promise<string> {
    return new TextDecoder().decode((await this.read(oid)).data)
  }

  #positions(): Map<number, number> {
    if (this.#byOffset !== undefined) return this.#byOffset
    const map = new Map<number, number>()
    for (let position = 0; position < this.index.oids.length; position += 1)
      map.set(spanAt(this.#spans, position).offset, position)
    this.#byOffset = map
    return map
  }

  async #object(offset: number): Promise<GitObject> {
    const position = this.#positions().get(offset)
    if (position === undefined) throw new Error(`no object at ${offset} in this pack`)
    const span = spanAt(this.#spans, position)
    const raw = await this.#source.bytes(span.offset, span.length)
    let header = at(raw, 0)
    const type = (header >> 4) & 7
    let size = header & 0x0f
    let shift = 4
    let cursor = 1
    while ((header & 0x80) !== 0) {
      header = at(raw, cursor)
      cursor += 1
      size += (header & 0x7f) * 2 ** shift
      shift += 7
    }
    const kind = KIND[type]
    if (kind !== undefined) return { kind, data: inflateObject(raw.subarray(cursor), size) }
    if (type === 6) {
      let base = at(raw, cursor)
      cursor += 1
      let distance = base & 0x7f
      while ((base & 0x80) !== 0) {
        base = at(raw, cursor)
        cursor += 1
        distance = (distance + 1) * 128 + (base & 0x7f)
      }
      const parent = await this.#object(offset - distance)
      return { kind: parent.kind, data: applyDelta(parent.data, inflateObject(raw.subarray(cursor), size)) }
    }
    if (type === 7) {
      const baseOid = hex(raw, cursor)
      const baseOffset = this.index.offsets.get(baseOid)
      if (baseOffset === undefined) throw new Error(`delta base ${baseOid} is not in this pack`)
      const parent = await this.#object(baseOffset)
      return { kind: parent.kind, data: applyDelta(parent.data, inflateObject(raw.subarray(cursor + 20), size)) }
    }
    throw new Error(`pack object type ${type} is not supported`)
  }
}
