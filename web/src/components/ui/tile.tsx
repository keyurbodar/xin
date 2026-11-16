import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"

type Phase = "waiting" | "loading" | "shown" | "failed"

/**
 * An image in a slot of fixed size: the fallback (a file icon or monogram) holds the slot until the image decodes, then
 * the image fades in over it with opacity only, so nothing shifts. `load` runs once the slot first scrolls into view;
 * a rejection or a broken image keeps the fallback.
 */
export function Tile(props: {
  load: () => Promise<string>
  alt: string
  fallback: JSX.Element
  fit?: "cover" | "contain"
  class: string
}): JSX.Element {
  let slot: HTMLSpanElement | undefined
  const [phase, setPhase] = createSignal<Phase>("waiting")
  const [src, setSrc] = createSignal<string | undefined>()

  onMount(() => {
    if (slot === undefined) return
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      seen.disconnect()
      setPhase("loading")
      props.load().then(setSrc, () => setPhase("failed"))
    })
    seen.observe(slot)
    onCleanup(() => seen.disconnect())
  })

  return (
    <span ref={slot} data-slot="tile" data-fit={props.fit ?? "cover"} data-phase={phase()} class={`relative block shrink-0 overflow-hidden ${props.class}`}>
      <Show when={phase() !== "shown"}>
        <span class="absolute inset-0 grid place-items-center">{props.fallback}</span>
      </Show>
      <Show when={phase() !== "failed" ? src() : undefined}>
        {(url) => (
          <img
            src={url()}
            alt={props.alt}
            decoding="async"
            draggable={false}
            class="absolute inset-0 size-full opacity-0 transition-opacity duration-[var(--dur-crossfade)] ease-[var(--ease-out)] data-[shown]:opacity-100"
            classList={{ "object-contain": props.fit === "contain", "object-cover": props.fit !== "contain" }}
            data-shown={phase() === "shown" ? "" : undefined}
            onLoad={(event) => {
              void event.currentTarget.decode().then(
                () => setPhase("shown"),
                () => setPhase("failed"),
              )
            }}
            onError={() => setPhase("failed")}
          />
        )}
      </Show>
    </span>
  )
}
