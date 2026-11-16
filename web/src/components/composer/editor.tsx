import type { Token, TokenInputValue, UiTokenInputElement } from "@ui-sdk/web/token-input"
import { ErrorBoundary, For, Show, createEffect, createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Stopped } from "../ui/stopped.tsx"
import { POPUP, POPUP_ITEM, POPUP_LABEL } from "../ui/surface.ts"
import { KIND, KindIcon } from "./kinds.tsx"
import type { Sources, Suggestion } from "./sources.ts"
import { loadUiSdk } from "../../lib/ui-sdk-lazy.ts"
import { composerCodec, formatToken, fromInputToken, toInputToken, type ComposerToken, type TokenKind } from "./tokens.ts"

/** What the composer, the + menu and plugin actions do to the draft. A prompt chip always goes first, replacing any other. */
export type EditorHandle = {
  readonly insert: (token: ComposerToken) => void
  readonly insertText: (text: string) => void
  readonly prepend: (text: string) => void
  readonly setText: (text: string) => void
  readonly text: () => string
  readonly clear: () => void
  readonly focus: () => void
}

const KINDS_FOR: Readonly<Record<string, readonly TokenKind[]>> = {
  "@": ["thread", "file"],
  "/": ["skill", "prompt"],
}

const FIELD = "block max-h-[320px] min-h-[48px] w-full overflow-y-auto whitespace-pre-wrap break-words px-4 pb-1 pt-3.5 text-body text-ink outline-none"

type Load = { readonly kind: "waiting" } | { readonly kind: "ready" } | { readonly kind: "failed"; readonly error: unknown }

const CHIP = "inline-flex items-baseline gap-1 rounded-xs text-primary-ink data-[selected]:bg-primary-soft"

function Chip(props: { token: ComposerToken }): JSX.Element {
  return (
    <ui-token-input-token class={CHIP}>
      <KindIcon kind={props.token.kind} size={14} class="shrink-0 self-center" />
      <span>{props.token.kind === "prompt" ? `/${props.token.label}` : props.token.label}</span>
    </ui-token-input-token>
  )
}

const disposers = new WeakMap<HTMLElement, () => void>()

function withPrompt(value: TokenInputValue, prompt: ComposerToken): TokenInputValue {
  const [first, ...others] = value
  const rest = first !== undefined && typeof first !== "string" && first.type === "prompt" ? others : value
  const [head, ...tail] = rest
  const body = typeof head === "string" ? [head.trimStart(), ...tail].filter((part) => part !== "") : rest
  return [toInputToken(prompt), " ", ...body]
}

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

function textBeforeCaret(editor: HTMLElement): string | undefined {
  const selection = document.getSelection()
  if (selection === null || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return undefined
  const range = document.createRange()
  range.setStart(editor, 0)
  range.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset)
  return range.toString()
}

function selectText(editor: HTMLElement, range: { readonly start: number; readonly end: number }): void {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  const target = document.createRange()
  let offset = 0
  let placed = 0
  for (let node = walker.nextNode(); node !== null && placed < 2; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (placed === 0 && range.start <= offset + length) {
      target.setStart(node, range.start - offset)
      placed = 1
    }
    if (placed === 1 && range.end <= offset + length) {
      target.setEnd(node, range.end - offset)
      placed = 2
    }
    offset += length
  }
  if (placed !== 2) return
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(target)
}

function recollapse(editor: HTMLElement): void {
  if (document.activeElement === editor) document.getSelection()?.collapse(editor, 0)
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
  onChange: (text: string) => void
  ref: (handle: EditorHandle) => void
}): JSX.Element {
  const [trigger, setTrigger] = createSignal<string>("@")
  let root!: HTMLDivElement
  let input!: UiTokenInputElement
  let editor!: HTMLElement
  let early: HTMLTextAreaElement | undefined
  let typed = ""

  const text = (): string => input.api.getText(composerCodec)
  const kinds = (): readonly TokenKind[] => KINDS_FOR[trigger()] ?? []
  const groups = (): readonly (readonly [TokenKind, readonly Suggestion[]])[] =>
    kinds().map((kind) => [kind, props.sources.list(kind)] as const)

  const replace = (start: number, end: number, value: string): void => {
    typed = typed.slice(0, start) + value + typed.slice(end)
    props.onChange(typed)
    if (early === undefined) return
    early.value = typed
    early.setSelectionRange(start + value.length, start + value.length)
  }
  const caret = (): readonly [number, number] => (early === undefined ? [typed.length, typed.length] : [early.selectionStart, early.selectionEnd])
  const plain: EditorHandle = {
    insert: (token) => (token.kind === "prompt" ? plain.prepend(`${formatToken(token)} `) : plain.insertText(`${formatToken(token)} `)),
    insertText: (value) => {
      const [start, end] = caret()
      const before = typed.slice(0, start)
      replace(start, end, before === "" || /\s$/u.test(before) ? value : ` ${value}`)
      early?.focus()
    },
    prepend: (value) => {
      replace(0, 0, value)
      early?.focus()
    },
    setText: (value) => replace(0, typed.length, value),
    text: () => typed,
    clear: () => replace(0, typed.length, ""),
    focus: () => early?.focus(),
  }
  let live = plain
  props.ref({
    insert: (token) => live.insert(token),
    insertText: (value) => live.insertText(value),
    prepend: (value) => live.prepend(value),
    setText: (value) => live.setText(value),
    text: () => live.text(),
    clear: () => live.clear(),
    focus: () => live.focus(),
  })

  const [load, setLoad] = createSignal<Load>({ kind: "waiting" })
  let composing = false
  let landed = false
  let carried: { readonly start: number; readonly end: number } | undefined
  const upgrade = (): void => {
    landed = false
    carried = early !== undefined && document.activeElement === early ? { start: early.selectionStart, end: early.selectionEnd } : undefined
    setLoad({ kind: "ready" })
  }
  const start = (): void => {
    setLoad({ kind: "waiting" })
    loadUiSdk("editor").then(
      () => {
        if (composing) landed = true
        else upgrade()
      },
      (error: unknown) => setLoad({ kind: "failed", error }),
    )
  }
  start()

  createEffect(() => {
    if (load().kind !== "ready") return
    const foundInput = root.querySelector("ui-token-input")
    const foundEditor = root.querySelector("ui-token-input-editor")
    const menu = root.querySelector("ui-trigger-menu")
    if (foundInput === null || foundEditor === null || menu === null) throw new Error("composer editor did not render")
    input = foundInput
    editor = foundEditor
    input.codec = composerCodec
    input.renderToken = renderChip
    menu.triggers = [
      { char: "@", type: "mention" },
      { char: "/", boundary: "start", type: "command" },
    ]
    live = {
      insert: (token) => {
        if (token.kind === "prompt") {
          input.api.setValue(withPrompt(input.api.getValue(), token))
          input.api.focus({ at: "end" })
          return
        }
        input.api.insert([toInputToken(token), " "])
        input.api.focus()
      },
      insertText: (value) => {
        const before = textBeforeCaret(editor) ?? text()
        input.api.insert(before === "" || /\s$/u.test(before) ? value : ` ${value}`)
        input.api.focus()
      },
      prepend: (value) => {
        input.api.insert(value, { at: { start: 0, end: 0 } })
        input.api.focus()
      },
      setText: (value) => input.api.setValue(value === "" ? [] : [value]),
      text,
      clear: () => input.api.clear(),
      focus: () => input.api.focus({ at: "end" }),
    }
    if (typed !== "") input.api.setValue([typed])
    const selection = carried
    if (selection === undefined) return
    queueMicrotask(() => {
      input.api.focus()
      selectText(editor, selection)
    })
  })

  const fallback = (): JSX.Element => (
    <textarea
      ref={early}
      aria-label={props.label}
      placeholder={props.placeholder}
      disabled={props.disabled}
      rows={1}
      value={typed}
      onInput={(event) => {
        typed = event.currentTarget.value
        props.onChange(typed)
      }}
      onCompositionStart={() => {
        composing = true
      }}
      onCompositionEnd={() => {
        composing = false
        if (landed) upgrade()
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
        event.preventDefault()
        event.currentTarget.form?.requestSubmit()
      }}
      class={`${FIELD} resize-none bg-transparent placeholder:text-placeholder disabled:opacity-60`}
    />
  )

  const connected = (): JSX.Element => (
    <ui-token-input
      disabled={props.disabled ? "" : undefined}
      on:valuechange={() =>
        queueMicrotask(() => {
          const current = text()
          if (current === "") recollapse(editor)
          props.onChange(current)
        })
      }
      class="block"
    >
      <ui-token-input-editor
        aria-label={props.label}
        placeholder={props.placeholder}
        class={`${FIELD} data-[empty]:before:pointer-events-none data-[empty]:before:text-placeholder data-[empty]:before:content-[attr(aria-placeholder)] data-[disabled]:opacity-60`}
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
  )

  const shown = (): JSX.Element => {
    const now = load()
    if (now.kind === "failed") throw now.error
    return now.kind === "ready" ? connected() : fallback()
  }

  return (
    <div ref={root} class="contents">
      <ErrorBoundary
        fallback={(error: unknown, reset) => (
          <Stopped
            title="The message box didn't load"
            error={error}
            onRetry={() => {
              start()
              reset()
              early?.focus()
            }}
            class="min-h-[48px] py-3"
          />
        )}
      >
        <>{shown()}</>
      </ErrorBoundary>
    </div>
  )
}
