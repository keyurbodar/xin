import "@ui-sdk/web/command"
import "@ui-sdk/web/menu"
import { ariaKeyshortcuts, formatShortcut } from "@ui-sdk/core"
import { ChevronRight, Paperclip, Plus } from "lucide-solid"
import { For, Show, createSignal, type JSX } from "solid-js"
import type { ProjectSummary } from "../../state/home.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM, POPUP_SEPARATOR } from "../ui/surface.ts"
import { KIND, KindIcon } from "./kinds.tsx"
import { createSources, type Suggestion } from "./sources.ts"
import { TOOL } from "./styles.ts"
import { formatToken, type ComposerToken, type TokenKind } from "./tokens.ts"

const UPLOAD_SHORTCUT = "mod+/"

const MENU_KINDS: readonly TokenKind[] = ["thread", "skill", "prompt", "file"]

export const KBD = "ml-auto inline-flex h-[var(--h-badge)] items-center rounded-xs bg-secondary px-1.5 font-mono text-micro text-ink-2"

function KindMenu(props: { kind: TokenKind; rows: readonly Suggestion[]; onPick: (token: ComposerToken) => void }): JSX.Element {
  let search: HTMLInputElement | undefined
  const label = (): string => KIND[props.kind].label
  return (
    <ui-menu-sub
      on:openchange={(event) => {
        if (event.detail.value) queueMicrotask(() => search?.focus())
      }}
    >
      <ui-menu-sub-trigger class={POPUP_ITEM}>
        <KindIcon kind={props.kind} />
        <span class="min-w-0 flex-1 truncate">{label()}</span>
        <ChevronRight size={14} stroke-width={1.5} class="shrink-0 text-icon" />
      </ui-menu-sub-trigger>
      <ui-menu-sub-content side-offset="6" class={`${POPUP} w-[min(300px,calc(100vw-16px))] p-0`}>
        <ui-command
          filter="contains"
          auto-highlight
          on:action={(event) => {
            const row = props.rows.find((entry) => entry.token.value === event.detail.value)
            if (row !== undefined) props.onPick(row.token)
          }}
          class="flex flex-col"
        >
          <div class="flex h-9 items-center border-b border-line-1 px-3">
            <ui-command-input class="contents">
              <input
                ref={(element) => (search = element)}
                aria-label={`Search ${label().toLowerCase()}`}
                placeholder={`Search ${label().toLowerCase()}`}
                class="h-full w-full bg-transparent text-small text-ink outline-none placeholder:text-placeholder"
              />
            </ui-command-input>
          </div>
          <ui-command-empty class="block px-3 py-2 text-small text-ink-3">No {label().toLowerCase()} found</ui-command-empty>
          <ui-command-list class="flex max-h-[min(var(--available-height,320px),320px)] flex-col overflow-y-auto p-1">
            <For each={props.rows}>
              {(row) => (
                <ui-command-item value={row.token.value} label={row.token.label} keywords={row.detail} class={POPUP_ITEM}>
                  <KindIcon kind={props.kind} />
                  <span class="min-w-0 shrink-0 truncate">{props.kind === "prompt" ? `/${row.token.label}` : row.token.label}</span>
                  <span class="min-w-0 flex-1 truncate text-right text-mini text-ink-3">{row.detail}</span>
                </ui-command-item>
              )}
            </For>
          </ui-command-list>
        </ui-command>
      </ui-menu-sub-content>
    </ui-menu-sub>
  )
}

/**
 * The + menu: upload a file, or put a chip for something the project already has into the draft. Each kind opens
 * a searchable submenu; kinds Ingle has no source for yet (people, Captains, pull requests, plugins, devices,
 * environment variables) stay out of the menu until they do.
 */
export function PlusMenu(props: {
  project: ProjectSummary
  disabled: boolean
  onUpload: () => void
  onInsert: (text: string, token: ComposerToken) => void
  onPrompt: (name: string, token: ComposerToken) => void
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const { mounted, settle } = createOverlayMount(open)
  const sources = createSources(() => props.project)
  let after: (() => void) | undefined

  const close = (then: () => void): void => {
    after = then
    setOpen(false)
  }

  const pick = (token: ComposerToken): void =>
    close(() => (token.kind === "prompt" ? props.onPrompt(token.value, token) : props.onInsert(`${formatToken(token)} `, token)))

  return (
    <ui-menu
      prop:open={open()}
      on:openchange={(event) => {
        event.preventDefault()
        const next = event.detail.value
        if (next) sources.load()
        queueMicrotask(() => setOpen(next))
      }}
      on:openchangecomplete={(event) => {
        settle(event)
        if (event.detail.value) return
        const run = after
        after = undefined
        run?.()
      }}
      on:action={(event) => {
        if (event.detail.value === "upload") close(props.onUpload)
      }}
    >
      <ui-menu-trigger>
        <button type="button" aria-label="Add" disabled={props.disabled} class={`${TOOL} w-[var(--h-control)] justify-center px-0`}>
          <Plus size={16} stroke-width={1.5} />
        </button>
      </ui-menu-trigger>
      <ui-menu-content side="top" align="start" side-offset="8" class={`${POPUP} w-[min(260px,calc(100vw-16px))]`}>
        <Show when={mounted()}>
          <ui-menu-item value="upload" aria-keyshortcuts={ariaKeyshortcuts(UPLOAD_SHORTCUT)} class={POPUP_ITEM}>
            <Paperclip size={16} stroke-width={1.5} class="shrink-0 text-icon" />
            <span class="min-w-0 flex-1 truncate">Upload attachment</span>
            <kbd aria-hidden="true" class={KBD}>
              {formatShortcut(UPLOAD_SHORTCUT)}
            </kbd>
          </ui-menu-item>
          <ui-menu-separator class={POPUP_SEPARATOR} />
          <For each={MENU_KINDS}>{(kind) => <KindMenu kind={kind} rows={sources.list(kind)} onPick={pick} />}</For>
        </Show>
      </ui-menu-content>
    </ui-menu>
  )
}
