import "@ui-sdk/web/file-input"
import "@ui-sdk/web/progress"
import { CircleAlert, File as FileIcon, X } from "lucide-solid"
import { For, Show, createEffect, createResource, createSignal, onCleanup, type JSX } from "solid-js"
import type { Lightbox as LightboxView, LightboxItem } from "../ui/lightbox.tsx"
import { render } from "solid-js/web"
import {
  blobUrl,
  hasThumbnail,
  kindLabel,
  sizeLabel,
  statusLabel,
  type ComposerAttachment,
  type SentAttachment,
} from "../../lib/attachments.ts"

const RING_RADIUS = 9
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

const CARD =
  "relative flex h-14 min-w-0 items-center gap-3 rounded-md bg-secondary py-2 pl-2 pr-1.5 text-left shadow-ring outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-primary"

function ProgressRing(props: { name: string; fraction: number }): JSX.Element {
  const percent = (): number => Math.round(props.fraction * 100)
  return (
    <ui-progress
      value={props.fraction > 0 ? String(percent()) : undefined}
      aria-label={`Uploading ${props.name}`}
      class="absolute inset-0 grid place-items-center bg-scrim"
    >
      <svg viewBox="0 0 24 24" class="h-6 w-6 -rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={RING_RADIUS} fill="none" stroke-width="2" class="stroke-line-3" />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={String(RING_LENGTH)}
          stroke-dashoffset={String(RING_LENGTH * (1 - Math.max(props.fraction, 0.04)))}
          class="stroke-primary transition-[stroke-dashoffset] duration-[var(--dur-grow)] ease-[var(--ease-out)]"
        />
      </svg>
    </ui-progress>
  )
}

function Thumbnail(props: { source: string | undefined; failed: boolean; children?: JSX.Element }): JSX.Element {
  const [broken, setBroken] = createSignal<string>()
  return (
    <span class="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted text-icon">
      <Show
        when={props.failed || props.source === broken() ? undefined : props.source}
        fallback={
          <Show when={props.failed} fallback={<FileIcon size={16} stroke-width={1.5} />}>
            <CircleAlert size={16} stroke-width={1.5} class="text-failed" />
          </Show>
        }
      >
        {(source) => <img src={source()} alt="" class="h-full w-full object-cover" onError={() => setBroken(source())} />}
      </Show>
      {props.children}
    </span>
  )
}

function Label(props: { name: string; meta: string; failed?: boolean }): JSX.Element {
  return (
    <span class="min-w-0 flex-1">
      <span class="block truncate text-small text-ink">{props.name}</span>
      <span
        class="block truncate text-mini tabular-nums"
        classList={{ "text-failed": props.failed === true, "text-ink-3": props.failed !== true }}
      >
        {props.meta}
      </span>
    </span>
  )
}

const ITEM = `im-arrive ${CARD} data-[state=failed]:shadow-[0_0_0_1px_var(--color-failed)]`

/**
 * One file the composer holds, drawn inside the item UI SDK's list made for it: "215 KB · PNG", the upload's progress
 * ring over its thumbnail, or why it failed.
 */
export function AttachmentCard(props: { item: ComposerAttachment; host: HTMLElement }): JSX.Element {
  const failed = (): boolean => props.item.state.kind === "failed"
  const progress = (): number | undefined =>
    props.item.state.kind === "uploading" ? props.item.state.progress : undefined
  const meta = (): string =>
    `${sizeLabel(props.item.file.size)} · ${statusLabel(props.item.state) ?? kindLabel(props.item.file.name, props.item.file.type)}`
  createEffect(() => {
    props.host.dataset.state = props.item.state.kind
  })
  return (
    <>
      <Thumbnail source={props.item.preview} failed={failed()}>
        <Show when={progress() !== undefined}>
          <ProgressRing name={props.item.file.name} fraction={progress() ?? 0} />
        </Show>
      </Thumbnail>
      <Label name={props.item.file.name} meta={meta()} failed={failed()} />
      <ui-file-input-item-remove class="shrink-0">
        <button
          type="button"
          class="im-press grid h-6 w-6 place-items-center rounded-sm text-icon hover:bg-hover hover:text-ink"
        >
          <X size={14} stroke-width={1.5} aria-hidden="true" />
        </button>
      </ui-file-input-item-remove>
    </>
  )
}

const filesOf = (value: unknown): readonly File[] =>
  Array.isArray(value) ? value.filter((entry): entry is File => entry instanceof File) : []

/**
 * The composer's files as a two-column grid of cards. UI SDK's file input owns the items and the keys: the list is one
 * Tab stop, arrows and Home/End move between cards, and Delete, Backspace or a card's × removes one, with focus moving
 * to a neighbour, or to `fallbackFocus` when none is left. Solid draws each card into the item the list made for its
 * file. A removal is instant, so a keyboard run of deletes never waits on an exit.
 */
export function AttachmentCardGrid(props: {
  items: readonly ComposerAttachment[]
  onRemove: (id: string) => void
  fallbackFocus?: () => HTMLElement | undefined
}): JSX.Element {
  let root: HTMLElement | undefined
  let list: HTMLElement | undefined
  const cards = new Map<Element, () => void>()
  const itemOf = (file: unknown): ComposerAttachment | undefined => props.items.find((item) => item.file === file)
  const sync = (): void => {
    if (list === undefined) return
    for (const [host, dispose] of cards) {
      if (host.parentElement === list) continue
      dispose()
      cards.delete(host)
    }
    for (const host of list.querySelectorAll<HTMLElement>(":scope > ui-file-input-item")) {
      if (cards.has(host)) continue
      const file: unknown = Reflect.get(host, "file")
      cards.set(
        host,
        render(() => <Show when={itemOf(file)}>{(item) => <AttachmentCard item={item()} host={host} />}</Show>, host),
      )
    }
  }
  const observer = new MutationObserver(sync)
  onCleanup(() => {
    observer.disconnect()
    for (const dispose of cards.values()) dispose()
  })
  createEffect(() => {
    const files = props.items.map((item) => item.file)
    if (root === undefined) return
    Reflect.set(root, "value", files)
    sync()
  })
  return (
    <ui-file-input
      ref={root}
      multiple
      classList={{ block: props.items.length > 0, hidden: props.items.length === 0 }}
      on:valuechange={(event) => {
        const kept = filesOf(event.detail.value)
        const hadFocus = root?.contains(document.activeElement) === true
        for (const item of props.items) if (!kept.includes(item.file)) props.onRemove(item.id)
        if (hadFocus)
          setTimeout(() => {
            if (root?.contains(document.activeElement) !== true) props.fallbackFocus?.()?.focus()
          })
      }}
    >
      <ui-file-input-list
        ref={(element: HTMLElement) => {
          list = element
          observer.observe(element, { childList: true })
        }}
        aria-label="Attachments"
        class="grid grid-cols-1 gap-2 min-[560px]:grid-cols-2"
      >
        <template innerHTML={`<ui-file-input-item class="${ITEM}"></ui-file-input-item>`} />
      </ui-file-input-list>
    </ui-file-input>
  )
}

function SentThumbnail(props: { file: SentAttachment }): JSX.Element {
  const [source] = createResource(
    () => (props.file.sha256 !== undefined && hasThumbnail(props.file.type) ? props.file.sha256 : undefined),
    (sha256) => blobUrl(sha256, props.file.type).catch(() => undefined),
  )
  return <Thumbnail source={source()} failed={false} />
}

const opensInLightbox = (file: SentAttachment): boolean => file.sha256 !== undefined && hasThumbnail(file.type)

/**
 * A sent message's files. An image whose bytes are stored is a button that calls `onOpen` with its index in
 * `attachments`, where the lightbox opens; any other file is shown, not pressed.
 */
export function MessageAttachments(props: {
  attachments: readonly SentAttachment[]
  onOpen: (index: number) => void
}): JSX.Element {
  const meta = (file: SentAttachment): string =>
    [file.size === undefined ? undefined : sizeLabel(file.size), kindLabel(file.name, file.type)]
      .filter((part) => part !== undefined)
      .join(" · ")
  return (
    <div class="@container w-full">
      <ul aria-label="Attachments" class="grid grid-cols-1 gap-2 @[400px]:grid-cols-2">
        <For each={props.attachments}>
          {(file, index) => (
            <li class="min-w-0">
              <Show
                when={opensInLightbox(file)}
                fallback={
                  <div class={CARD}>
                    <SentThumbnail file={file} />
                    <Label name={file.name} meta={meta(file)} />
                  </div>
                }
              >
                <button
                  type="button"
                  aria-label={`Open ${file.name}`}
                  class={`im-press w-full hover:bg-hover ${CARD}`}
                  onClick={() => props.onOpen(index())}
                >
                  <SentThumbnail file={file} />
                  <Label name={file.name} meta={meta(file)} />
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

/**
 * A sent message's files with the lightbox behind them, loaded on the first open so it stays out of the startup
 * bundle: opening an image shows every image of the message, each read
 * once from `GET /blobs/<sha256>` into the object URL its thumbnail already uses. An image whose bytes are gone becomes a
 * plain card and is left out of the lightbox.
 */
let lightboxLoader: Promise<typeof LightboxView> | undefined

export function SentAttachments(props: { attachments: readonly SentAttachment[] }): JSX.Element {
  const [Lightbox, setLightbox] = createSignal<typeof LightboxView>()
  const [open, setOpen] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  const images = (): readonly SentAttachment[] => props.attachments.filter(opensInLightbox)
  const [sources] = createResource(images, (files) =>
    Promise.all(files.map((file) => blobUrl(file.sha256 ?? "", file.type).catch(() => undefined))),
  )
  const items = (): readonly (LightboxItem & { readonly file: SentAttachment })[] =>
    images().flatMap((file, at) => {
      const src = sources()?.[at]
      return src === undefined ? [] : [{ src, name: file.name, size: file.size, type: file.type, file }]
    })
  const shown = (): readonly SentAttachment[] => {
    const loaded = sources()
    if (loaded === undefined) return props.attachments
    const gone = new Set(images().filter((_file, at) => loaded[at] === undefined))
    return props.attachments.map((file) => (gone.has(file) ? { ...file, sha256: undefined } : file))
  }
  return (
    <>
      <MessageAttachments
        attachments={shown()}
        onOpen={(at) => {
          const found = items().findIndex((item) => item.file === props.attachments[at])
          if (found < 0) return
          setIndex(found)
          lightboxLoader ??= import("../ui/lightbox.tsx").then((module) => module.Lightbox)
          void lightboxLoader.then((view) => {
            setLightbox(() => view)
            setOpen(true)
          })
        }}
      />
      <Show when={Lightbox()}>
        {(View) => {
          const Viewer = View()
          return <Viewer items={items()} index={index()} open={open()} onClose={() => setOpen(false)} onIndexChange={setIndex} />
        }}
      </Show>
    </>
  )
}
