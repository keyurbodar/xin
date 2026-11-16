import { fetchBlob } from "./attachments.ts"

export const BLOB_CACHE_ENTRIES = 24
export const BLOB_CACHE_BYTES = 16 * 1024 * 1024

type Slot = { readonly url: Promise<string>; href?: string; bytes: number }

export type BlobCache = {
  /** An object URL for a stored blob, fetched once while it stays cached. */
  readonly url: (sha256: string, type: string) => Promise<string>
  /** Revokes every URL; a fetch still running is revoked as soon as it lands. */
  readonly clear: () => void
}

/**
 * Object URLs for stored blobs, least recently used first out: past `entries` URLs or `bytes` of blobs the oldest
 * loaded ones are revoked, never the one that just arrived, so one large picture still shows.
 */
export function createBlobCache(
  load: (sha256: string, type: string) => Promise<Blob> = fetchBlob,
  limits: { readonly entries: number; readonly bytes: number } = { entries: BLOB_CACHE_ENTRIES, bytes: BLOB_CACHE_BYTES },
): BlobCache {
  const slots = new Map<string, Slot>()
  let held = 0

  const drop = (sha256: string, slot: Slot): void => {
    slots.delete(sha256)
    held -= slot.bytes
    if (slot.href !== undefined) URL.revokeObjectURL(slot.href)
  }

  const evict = (keep: Slot): void => {
    for (const [sha256, slot] of slots) {
      if (slots.size <= limits.entries && held <= limits.bytes) return
      if (slot !== keep && slot.href !== undefined) drop(sha256, slot)
    }
  }

  return {
    url: (sha256, type) => {
      const known = slots.get(sha256)
      if (known !== undefined) {
        slots.delete(sha256)
        slots.set(sha256, known)
        return known.url
      }
      const url = load(sha256, type).then(
        (blob) => {
          const href = URL.createObjectURL(blob)
          if (slots.get(sha256) !== slot) {
            URL.revokeObjectURL(href)
            return href
          }
          slot.href = href
          slot.bytes = blob.size
          held += blob.size
          evict(slot)
          return href
        },
        (failure: unknown) => {
          if (slots.get(sha256) === slot) slots.delete(sha256)
          throw failure
        },
      )
      const slot: Slot = { url, bytes: 0 }
      slots.set(sha256, slot)
      evict(slot)
      return url
    },
    clear: () => {
      for (const [sha256, slot] of slots) drop(sha256, slot)
    },
  }
}
