import "solid-js"
import type { TokenInsert } from "@ui-sdk/web/trigger-menu"

type UiChange<T = unknown> = CustomEvent<{ readonly value: T; readonly reason: string; readonly event?: Event }>

declare module "solid-js" {
  namespace JSX {
    type UiElementProps = HTMLAttributes<HTMLElement> & {
      readonly [attribute: string]: unknown
    }

    interface IntrinsicElements {
      readonly [tag: `ui-${string}`]: UiElementProps
    }

    interface CustomEvents {
      openchange: CustomEvent<{ readonly value: boolean; readonly reason: string; readonly trigger?: string | null }>
      openchangecomplete: UiChange<boolean>
      dismissattempt: CustomEvent<{ readonly reason: string }>
      action: CustomEvent<{ readonly value: string }>
      valuechange: UiChange
      pressedchange: UiChange<boolean>
      querychange: CustomEvent<{ readonly value: string; readonly trigger: string }>
      itemselect: CustomEvent<{
        readonly value: string
        readonly trigger: string
        readonly insert: (content: string | TokenInsert) => void
      }>
    }

    interface CustomCaptureEvents {
      paste: ClipboardEvent
    }
  }
}
