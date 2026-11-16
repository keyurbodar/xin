import { afterEach, expect, test } from "bun:test"
import { createBlobCache } from "./blob-cache.ts"

const revoked: string[] = []
const original = URL.revokeObjectURL
URL.revokeObjectURL = (href: string) => {
  revoked.push(href)
  original(href)
}
afterEach(() => {
  revoked.length = 0
})

const fetched: string[] = []
const sized = (bytes: number) => async (sha256: string) => {
  fetched.push(sha256)
  return new Blob([new Uint8Array(bytes)])
}

test("a cached blob is fetched once, and the least recently used is revoked past the entry limit", async () => {
  fetched.length = 0
  const cache = createBlobCache(sized(10), { entries: 2, bytes: 1000 })
  const a = await cache.url("a", "image/png")
  const b = await cache.url("b", "image/png")
  expect(await cache.url("a", "image/png")).toBe(a)
  await cache.url("c", "image/png")
  expect(revoked).toEqual([b])
  expect(fetched).toEqual(["a", "b", "c"])
})

test("the byte limit evicts the oldest blobs but never the newest, however large", async () => {
  const cache = createBlobCache(sized(400), { entries: 10, bytes: 1000 })
  const a = await cache.url("a", "image/png")
  const b = await cache.url("b", "image/png")
  expect(revoked).toEqual([])
  await cache.url("c", "image/png")
  expect(revoked).toEqual([a])
  await cache.url("d", "image/png")
  expect(revoked).toEqual([a, b])
  const huge = createBlobCache(sized(5000), { entries: 10, bytes: 1000 })
  const only = await huge.url("x", "image/png")
  expect(revoked).toEqual([a, b])
  await huge.url("y", "image/png")
  expect(revoked).toEqual([a, b, only])
})

test("a large blob that lands after a newer request is kept, and the older loaded blob goes instead", async () => {
  let release = (): void => {}
  const cache = createBlobCache(
    async (sha256) => {
      if (sha256 === "big") await new Promise<void>((resolve) => (release = resolve))
      return new Blob([new Uint8Array(sha256 === "big" ? 5000 : 10)])
    },
    { entries: 10, bytes: 1000 },
  )
  const big = cache.url("big", "image/png")
  const small = await cache.url("small", "image/png")
  expect(revoked).toEqual([])
  release()
  const href = await big
  expect(revoked).toEqual([small])
  expect(await cache.url("big", "image/png")).toBe(href)
})

test("clear revokes every URL, and one still loading is revoked when it lands", async () => {
  let release = (): void => {}
  const cache = createBlobCache(async (sha256) => {
    if (sha256 === "slow") await new Promise<void>((resolve) => (release = resolve))
    return new Blob([new Uint8Array(1)])
  })
  const fast = await cache.url("fast", "image/png")
  const slow = cache.url("slow", "image/png")
  cache.clear()
  expect(revoked).toEqual([fast])
  release()
  expect(revoked).toEqual([fast, await slow])
})

test("a failed fetch is forgotten, so the next ask tries again", async () => {
  let tries = 0
  const cache = createBlobCache(async () => {
    tries += 1
    if (tries === 1) throw new Error("gone")
    return new Blob([new Uint8Array(1)])
  })
  expect(cache.url("a", "image/png")).rejects.toThrow("gone")
  await Promise.resolve()
  await Promise.resolve()
  expect(await cache.url("a", "image/png")).toStartWith("blob:")
  expect(tries).toBe(2)
})
