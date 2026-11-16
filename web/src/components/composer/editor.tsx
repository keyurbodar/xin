import "@ui-sdk/web/token-input"
import "@ui-sdk/web/trigger-menu"
import type { Token, UiTokenInputElement } from "@ui-sdk/web/token-input"
import { For, Show, createSignal, onMount, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { POPUP, POPUP_ITEM, POPUP_LABEL } from "../ui/surface.ts"
import { KIND, KindIcon } from "./kinds.tsx"
import type { Sources, Suggestion } from "./sources.ts"
import { composerCodec, fromInputToken, parseDraft, toInputToken, type ComposerToken, type TokenKind } from "./tokens.ts"

/** What the composer card and the + menu do to the draft. */
export type EditorHandle = {
  readonly insert: (token: ComposerToken) => void
  readonly text: () => string
  readonly clear: () => void
  readonly focus: () => void
}

const KINDS_FOR: Readonly<Record<string, readonly TokenKind[]>> = {
  "@": ["thread", "file"],
  "/": ["skill", "prompt"],
}

export const CHIP = "inline-flex items-baseline gap-1 rounded-xs text-primary-ink data-[selected]:bg-primary-soft"

function Chip(props: { token: ComposerToken }): JSX.Element {
  return (
    <ui-token-input-token class={CHIP}>
      <KindIcon kind={props.token.kind} size={14} class="shrink-0 self-center" />
      <span>{props.token.kind === "prompt" ? `/${props.token.label}` : props.token.label}</span>
    </ui-token-input-token>
  )
}

const disposers = new WeakMap<HTMLElement, () => void>()

function renderChip(token: Token, host: HTMLElement): void {
  disposers.get(host)?.()
  host.textContent = ""
  const known = fromInputToken(token)
  if (known === undefined) {
    host.textContent = token.label
    return
  }
  disposers.set(host, render(() => <Chip token={known} />, host))
}

/**
 * The draft: text with atomic chips. `@` suggests threads and files, `/` at the start suggests skills and prompts,
 * and each choice becomes a chip that Backspace removes whole. Enter submits the form around it, Shift+Enter breaks
 * the line, and an open menu or an input method composing text takes Enter first.
 */
export function ComposerEditor(props: {
  sources: Sources
  label: string
  placeholder: string
  disabled: boolean
  initial?: string | undefined
  onChange: (text: string) => void
  ref: (handle: EditorHandle) => void
}): JSX.Element {
  const [trigger, setTrigger] = createSignal<string>("@")
  let root!: HTMLDivElement
  let input!: UiTokenInputElement

  const text = (): string => input.api.getText(composerCodec)
  const kinds = (): readonly TokenKind[] => KINDS_FOR[trigger()] ?? []
  const groups = (): readonly (readonly [TokenKind, readonly Suggestion[]])[] =>
    kinds().map((kind) => [kind, props.sources.list(kind)] as const)

  onMount(() => {
    const foundInput = root.querySelector("ui-token-input")
    const menu = root.querySelector("ui-trigger-menu")
    if (foundInput === null || menu === null) throw new Error("composer editor did not render")
    input = foundInput
    input.codec = composerCodec
    input.renderToken = renderChip
    menu.triggers = [
      { char: "@", type: "mention" },
      { char: "/", boundary: "start", type: "command" },
    ]
    if (props.initial !== undefined && props.initial !== "") input.api.setValue(parseDraft(props.initial))
    props.ref({
      insert: (token) => {
        input.api.insert([toInputToken(token), " "])
        input.api.focus()
      },
      text,
      clear: () => input.api.clear(),
      focus: () => input.api.focus({ at: "end" }),
    })
  })

  return (
    <div ref={root} class="contents">
    <ui-token-input
      disabled={props.disabled ? "" : undefined}
      on:valuechange={() => queueMicrotask(() => props.onChange(text()))}
      class="block"
    >
      <ui-token-input-editor
        aria-label={props.label}
        placeholder={props.placeholder}
        class="block max-h-[320px] min-h-[48px] w-full overflow-y-auto whitespace-pre-wrap break-words px-4 pb-1 pt-3.5 text-body text-ink outline-none data-[empty]:before:pointer-events-none data-[empty]:before:text-placeholder data-[empty]:before:content-[attr(aria-placeholder)] data-[disabled]:opacity-60"
      />
      <ui-trigger-menu
        on:openchange={(event) => {
          const next = event.detail.trigger
          if (event.detail.value && next !== undefined && next !== null) setTrigger(next)
          if (event.detail.value) props.sources.load()
        }}
        on:itemselect={(event) => {
          const chosen = groups()
            .flatMap(([, rows]) => rows)
            .find((row) => `${row.token.kind}:${row.token.value}` === event.detail.value)
          if (chosen !== undefined) event.detail.insert(toInputToken(chosen.token))
        }}
      >
        <ui-trigger-menu-content side="top" align="start" side-offset="6" class={`${POPUP} w-[min(340px,calc(100vw-16px))]`}>
          <ui-trigger-menu-empty class="block px-2 py-1.5 text-small text-ink-3">Nothing matches</ui-trigger-menu-empty>
          <ui-trigger-menu-list class="flex flex-col">
            <For each={groups()}>
              {([kind, rows]) => (
                <Show when={rows.length > 0}>
                  <ui-trigger-menu-group class="flex flex-col">
                    <ui-trigger-menu-group-label class={POPUP_LABEL}>{KIND[kind].label}</ui-trigger-menu-group-label>
                    <For each={rows}>
                      {(row) => (
                        <ui-trigger-menu-item value={`${kind}:${row.token.value}`} label={row.token.label} class={POPUP_ITEM}>
                          <ui-trigger-menu-item-icon>
                            <KindIcon kind={kind} />
                          </ui-trigger-menu-item-icon>
                          <span class="min-w-0 shrink-0 truncate">{kind === "prompt" ? `/${row.token.label}` : row.token.label}</span>
                          <span class="min-w-0 flex-1 truncate text-mini text-ink-3">{row.detail}</span>
                        </ui-trigger-menu-item>
                      )}
                    </For>
                  </ui-trigger-menu-group>
                </Show>
              )}
            </For>
          </ui-trigger-menu-list>
        </ui-trigger-menu-content>
      </ui-trigger-menu>
    </ui-token-input>
    </div>
  )
}
