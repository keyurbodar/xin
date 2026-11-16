const once = (load: () => Promise<unknown>): (() => Promise<unknown>) => {
  let loading: Promise<unknown> | undefined
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined
      throw error
    }))
}

export const loadEditorElements = once(() => Promise.all([import("@ui-sdk/web/token-input"), import("@ui-sdk/web/trigger-menu")]))
export const loadMenuElements = once(() => Promise.all([import("@ui-sdk/web/menu"), import("@ui-sdk/web/command")]))
export const loadComboboxElements = once(() => import("@ui-sdk/web/combobox"))

/** Trigger handlers that load a popup's elements on first hover or focus, and replay a click that came before them. */
export function loadOnIntent(load: () => Promise<unknown>, tag: string) {
  return {
    onPointerEnter: (): void => void load(),
    onFocus: (): void => void load(),
    onClick: (event: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
      if (customElements.get(tag) !== undefined) return
      const button = event.currentTarget
      void load().then(() => button.click())
    },
  }
}
