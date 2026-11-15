import type { Resource } from "solid-js"

/** A skeleton stands in only until a resource's first value lands; a refetch keeps the stale value on screen. */
export function firstLoad(resource: Pick<Resource<unknown>, "state">): boolean {
  return resource.state === "pending"
}

export type Keyed<T> = { readonly key: string; readonly value: T }

type KeyedResource<T> = Pick<Resource<Keyed<T> | undefined>, "state" | "latest">

/** A new key is a first load, so the skeleton shows; a refetch of the same key keeps its value on screen. */
export function firstLoadFor<T>(resource: KeyedResource<T>, key: string): boolean {
  if (resource.state === "pending") return true
  return resource.state === "refreshing" && resource.latest?.key !== key
}

/** The value read for `key`, never one left over from another key. */
export function valueFor<T>(resource: KeyedResource<T>, key: string): T | undefined {
  if (resource.state !== "ready" && resource.state !== "refreshing") return undefined
  const latest = resource.latest
  return latest?.key === key ? latest.value : undefined
}
