import { createSignal, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

type Props = Record<string, unknown>

type State<P extends Props> = { readonly kind: "waiting" } | { readonly kind: "loaded"; readonly view: Component<P> } | { readonly kind: "failed"; readonly error: unknown }

export type LazyView<P extends Props> = Component<P> & { readonly preload: () => Promise<unknown> }

/**
 * A view whose module loads the first time it renders or `preload()` runs, showing `fallback` with the same props until then. Unlike
 * `lazy()` it never suspends, so the resources the view reads once loaded keep their own loading states instead of
 * reaching an outer Suspense boundary. A failed load throws to the nearest ErrorBoundary and loads again on its reset.
 */
export function lazyView<P extends Props>(load: () => Promise<Component<P>>, fallback: (props: P) => JSX.Element): LazyView<P> {
  const [state, setState] = createSignal<State<P>>({ kind: "waiting" })
  let loading: Promise<unknown> | undefined
  const preload = (): Promise<unknown> => {
    loading ??= load().then(
      (view) => setState({ kind: "loaded", view }),
      (error: unknown) => {
        loading = undefined
        setState({ kind: "failed", error })
      },
    )
    return loading
  }
  const view = (props: P): JSX.Element => {
    if (state().kind === "failed") setState({ kind: "waiting" })
    void preload()
    const shown = (): JSX.Element => {
      const now = state()
      if (now.kind === "failed") throw now.error
      return now.kind === "loaded" ? <Dynamic component={now.view} {...props} /> : fallback(props)
    }
    return <>{shown()}</>
  }
  return Object.assign(view, { preload })
}
