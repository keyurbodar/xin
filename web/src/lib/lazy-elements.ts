export const once = (load: () => Promise<unknown>): (() => Promise<unknown>) => {
  let loading: Promise<unknown> | undefined
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined
      throw error
    }))
}

/** Trigger handlers that load a popup's elements on first hover, focus or press, and replay a click that came before them. */
export function loadOnIntent(load: () => Promise<unknown>, tag: string) {
  return {
    onPointerEnter: (): void => void load(),
    onFocus: (): void => void load(),
    onPointerDown: (): void => void load(),
    onClick: (event: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
      if (customElements.get(tag) !== undefined) return
      const button = event.currentTarget
      void load().then(() => button.click())
    },
  }
}
