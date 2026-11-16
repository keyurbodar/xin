import { File, MessagesSquare, Sparkle, SquareSlash } from "lucide-solid"
import type { JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { TokenKind } from "./tokens.ts"

type Glyph = (props: { size: number; "stroke-width": number; class?: string }) => JSX.Element

export const KIND: Readonly<Record<TokenKind, { readonly label: string; readonly icon: Glyph }>> = {
  thread: { label: "Threads", icon: MessagesSquare },
  skill: { label: "Skills", icon: Sparkle },
  prompt: { label: "Prompts", icon: SquareSlash },
  file: { label: "Files", icon: File },
}

export function KindIcon(props: { kind: TokenKind; size?: number; class?: string }): JSX.Element {
  return <Dynamic component={KIND[props.kind].icon} size={props.size ?? 16} stroke-width={1.5} class={props.class ?? "shrink-0 text-icon"} />
}
