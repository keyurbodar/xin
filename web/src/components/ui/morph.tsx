import { createEffect, onCleanup, onMount, type JSX } from "solid-js"
import { TextMorph } from "torph"

/** Torph settles numbers by place value and text by character, so a count never pops. */
export function Morph(props: { value: string | number; numbers?: boolean; class?: string; duration?: number }): JSX.Element {
  let element!: HTMLSpanElement
  let morph: TextMorph | undefined

  onMount(() => {
    morph = new TextMorph({
      element,
      numbers: props.numbers ?? false,
      duration: props.duration ?? 400,
      respectReducedMotion: true,
      locale: navigator.language,
    })
    morph.update(props.value)
  })

  createEffect(() => {
    const value = props.value
    morph?.update(value)
  })

  onCleanup(() => morph?.destroy())

  return <span ref={element} class={props.class} />
}
