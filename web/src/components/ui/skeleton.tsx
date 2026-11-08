import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Reveal } from "skullet"

/**
 * Skullet draws the skeleton over a sample render of the same layout, so nothing moves when the
 * data lands. Solid keeps ownership of the live tree: the ghost lives in its own layer and is
 * dropped the moment the content mounts.
 */
export function Skullet(props: {
  loading: boolean
  sample: () => JSX.Element
  children: JSX.Element
  label?: string
}): JSX.Element {
  let layer!: HTMLDivElement
  const [ready, setReady] = createSignal(!props.loading)
  let reveal: Reveal | undefined
  let dispose: (() => void) | undefined

  onMount(() => {
    if (!props.loading) return
    reveal = new Reveal(layer, { label: props.label ?? "Loading" })
    const probe = document.createElement("div")
    dispose = render(() => props.sample(), probe)
    reveal.load(probe)
  })

  createEffect(() => {
    if (props.loading || ready()) return
    reveal?.destroy()
    reveal = undefined
    dispose?.()
    dispose = undefined
    layer.replaceChildren()
    setReady(true)
  })

  onCleanup(() => {
    reveal?.destroy()
    dispose?.()
  })

  return (
    <>
      <div>{<Show when={ready()}>{props.children}</Show>}</div>
      <div ref={layer} hidden={ready()} />
    </>
  )
}
