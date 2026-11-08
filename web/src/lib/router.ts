import { createSignal } from "solid-js"

export type Route = {
  readonly path: string
  readonly parts: readonly string[]
}

function read(): Route {
  const raw = window.location.hash.replace(/^#/, "")
  const path = raw === "" ? "/" : raw
  return { path, parts: path.split("/").filter((part) => part !== "") }
}

const [route_, setRoute] = createSignal<Route>(read())

window.addEventListener("hashchange", () => setRoute(read()))

export const route = route_

export function navigate(to: string): void {
  if (window.location.hash === `#${to}`) return
  window.location.hash = to
}

export function param(index: number): string | undefined {
  return route_().parts[index]
}
