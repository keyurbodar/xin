import "@ui-sdk/web/separator"
import { For, type JSX } from "solid-js"
import { Signal } from "../../ui/signal.tsx"
import { waitPhrase, type Phrase, type TimelineLink, type WaitTarget } from "./model.ts"

export type RenderLink = (link: TimelineLink) => JSX.Element

export const plainLink: RenderLink = (link) => <span class="text-primary-ink">{link.label}</span>

function PhraseText(props: { phrase: Phrase; renderLink: RenderLink }): JSX.Element {
  return <For each={props.phrase}>{(part) => (typeof part === "string" ? part : props.renderLink(part))}</For>
}

export function DateDivider(props: { label: string }): JSX.Element {
  return (
    <ui-separator aria-label={props.label} data-date-divider="" class="flex items-center gap-2 py-1">
      <span class="h-px flex-1 bg-line-2" />
      <span class="size-[5px] rotate-45 bg-line-3" />
      <span class="text-small text-ink-3">{props.label}</span>
      <span class="size-[5px] rotate-45 bg-line-3" />
      <span class="h-px flex-1 bg-line-2" />
    </ui-separator>
  )
}

export function TurnSummary(props: { phrase: Phrase; renderLink: RenderLink }): JSX.Element {
  return (
    <p data-turn-summary="" class="im-event m-0 py-1 text-center text-mini text-ink-3">
      <PhraseText phrase={props.phrase} renderLink={props.renderLink} />
    </p>
  )
}

export function WaitingLine(props: { target: WaitTarget; renderLink: RenderLink }): JSX.Element {
  return (
    <p role="status" data-waiting="" class="im-event m-0 flex items-center justify-center gap-2 py-1 text-small text-ink-3">
      <Signal state={props.target.kind === "person" ? "needs" : "working"} size={12} />
      <span>
        <PhraseText phrase={waitPhrase(props.target)} renderLink={props.renderLink} />
      </span>
    </p>
  )
}
