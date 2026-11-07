import { createSignal, onCleanup, type Accessor } from "solid-js"

/** A live media query, so a screen renders one container instead of two hidden ones. */
export function mediaQuery(query: string): Accessor<boolean> {
  const list = window.matchMedia(query)
  const [matches, setMatches] = createSignal(list.matches)
  const onChange = (event: MediaQueryListEvent): void => {
    setMatches(event.matches)
  }
  list.addEventListener("change", onChange)
  onCleanup(() => list.removeEventListener("change", onChange))
  return matches
}
