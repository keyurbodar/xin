import type { Resource } from "solid-js"

/** A skeleton stands in only until a resource's first value lands; a refetch keeps the stale value on screen. */
export function firstLoad(resource: Pick<Resource<unknown>, "state">): boolean {
  return resource.state === "pending"
}
