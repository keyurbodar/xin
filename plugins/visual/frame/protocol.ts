import type { Token } from "../runtime/style.ts"

export type FrameTheme = {
  readonly scheme: "dark" | "light"
  readonly colors: Readonly<Record<Token, string>>
  readonly reduceMotion: boolean
}

/** What the host page sends into a visual's frame. */
export type HostMessage =
  | {
      readonly kind: "show"
      readonly script: string
      readonly id: string
      readonly streaming: boolean
      readonly theme: FrameTheme
    }
  | { readonly kind: "theme"; readonly theme: FrameTheme }
  | { readonly kind: "font"; readonly family: string; readonly data: ArrayBuffer; readonly weight: string }

/** What a visual's frame reports back. */
export type FrameMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "size"; readonly height: number }
  | { readonly kind: "state"; readonly state: "drawing" | "shown" | "error"; readonly error?: string }
  | { readonly kind: "open"; readonly url: string }
