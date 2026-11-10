import { describe, expect, it } from "vitest"
import { FULL_PACK, HISTORY_PACK, NOTES_LINES } from "../../test/plugins/gitnative.ts"
import { PackObjects } from "./objects.ts"
import { buildIndex, memorySource, readIndex, spanAt, subtleSha1 } from "./pack.ts"

const objectId = async (kind: string, data: Uint8Array): Promise<string> => {
  const header = new TextEncoder().encode(`${kind} ${data.length}\u0000`)
  const joined = new Uint8Array(header.length + data.length)
  joined.set(header)
  joined.set(data, header.length)
  return subtleSha1(joined)
}

describe("pack reader", () => {
  it("indexes a pack and reads every object back to its own id", async () => {
    const built = await buildIndex(FULL_PACK, subtleSha1)
    expect(built.hashed).toBe(14)
    const index = readIndex(built.idx)
    expect(index.oids).toEqual([...built.index.oids])
    const objects = new PackObjects(index, built.spans, memorySource(FULL_PACK))
    for (const oid of index.oids) {
      const object = await objects.read(oid)
      expect(await objectId(object.kind, object.data)).toBe(oid)
    }
  })

  it("points each span at the bytes of that object", async () => {
    const built = await buildIndex(FULL_PACK, subtleSha1)
    const spans = Array.from({ length: built.index.oids.length }, (_, position) => spanAt(built.spans, position))
    expect(new Set(spans.map((span) => span.offset)).size).toBe(spans.length)
    for (const span of spans) {
      expect(span.length).toBeGreaterThan(0)
      expect(span.offset + span.length).toBeLessThanOrEqual(FULL_PACK.byteLength - 20)
    }
  })

  it("resolves a deltified blob to the file it holds", async () => {
    const built = await buildIndex(FULL_PACK, subtleSha1)
    const objects = new PackObjects(readIndex(built.idx), built.spans, memorySource(FULL_PACK))
    const notes: string[] = []
    for (const oid of built.index.oids) {
      const object = await objects.read(oid)
      if (object.kind !== "blob") continue
      const text = new TextDecoder().decode(object.data)
      if (text.includes("line one hundred and fifty")) notes.push(text)
    }
    expect(notes).toHaveLength(1)
    const text = notes[0] ?? ""
    expect(text.split("\n")).toHaveLength(NOTES_LINES + 1)
    expect(text.startsWith("line one\n")).toBe(true)
  })

  it("reads a history-only pack, which carries commits and trees but no file contents", async () => {
    const built = await buildIndex(HISTORY_PACK, subtleSha1)
    const objects = new PackObjects(readIndex(built.idx), built.spans, memorySource(HISTORY_PACK))
    const kinds = new Set<string>()
    for (const oid of built.index.oids) kinds.add((await objects.read(oid)).kind)
    expect([...kinds].toSorted()).toEqual(["commit", "tree"])
  })
})
