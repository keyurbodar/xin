import "solid-js"

type UiChange<T = unknown> = CustomEvent<{ readonly value: T; readonly reason: string }>

declare module "solid-js" {
  namespace JSX {
    type UiElementProps = HTMLAttributes<HTMLElement> & {
      readonly [attribute: string]: unknown
    }

    interface IntrinsicElements {
      readonly [tag: `ui-${string}`]: UiElementProps
    }

    interface CustomEvents {
      openchange: UiChange<boolean>
      openchangecomplete: UiChange<boolean>
      dismissattempt: CustomEvent<{ readonly reason: string }>
      action: CustomEvent<{ readonly value: string }>
      valuechange: UiChange
    }
  }
}
