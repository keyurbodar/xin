import "@ui-sdk/web/file-input"
import "@ui-sdk/web/progress"
import { CircleAlert, File as FileIcon, X } from "lucide-solid"
import { For, Show, createContext, createEffect, createSignal, on, onCleanup, useContext, type JSX } from "solid-js"
import { createBlobCache, type BlobCache } from "../../lib/blob-cache.ts"
import { Tile } from "../ui/tile.tsx"
import type { Lightbox as LightboxView, LightboxItem } from "../ui/lightbox.tsx"
import { render } from "solid-js/web"
import {
  hasCardThumbnail,
  isOpenable,
  kindLabel,
  sizeLabel,
  statusLabel,
  type ComposerAttachment,
  type SentAttachment,
} from "../../lib/attachments.ts"

const RING_RADIUS = 9
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

const CARD =
  "relative flex h-14 min-w-0 items-center gap-3 rounded-md bg-secondary py-2 pl-2 pr-1.5 text-left shadow-ring outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus"

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

const SentBlobs = createContext<BlobCache>()

/**
 * One blob cache for a transcript's sent attachments: every card and the lightbox share its object URLs, and all of
 * them are revoked when `scope` changes (another thread in the same transcript) or the transcript unmounts.
 */
export function SentBlobsScope(props: { scope: unknown; children: JSX.Element }): JSX.Element {
  const blobs = createBlobCache()
  createEffect(on(() => props.scope, () => blobs.clear(), { defer: true }))
  onCleanup(blobs.clear)
  return <SentBlobs.Provider value={blobs}>{props.children}</SentBlobs.Provider>
}

function useSentBlobs(): BlobCache {
  const shared = useContext(SentBlobs)
  if (shared !== undefined) return shared
  const own = createBlobCache()
  onCleanup(own.clear)
  return own
}

async function decodes(url: string): Promise<string> {
  const image = new Image()
  image.src = url
  await image.decode()
  return url
}

type Decoded = "yes" | "no"

/**
 * A sent message's files. A raster image up to `THUMBNAIL_BYTES` reads its thumbnail once its card scrolls into view
 * and becomes an Open button only once those bytes decode, so HTML stored as image/png never opens; a larger one keeps
 * its icon card and is a button from the start, its bytes read only when it is opened. SVG and other files are plain
 * cards. `onOpen` gets the index in `attachments`.
 */
export function MessageAttachments(props: {
  attachments: readonly SentAttachment[]
  decoded: (file: SentAttachment) => Decoded | undefined
  load: (file: SentAttachment) => Promise<string>
  onOpen: (index: number) => void
}): JSX.Element {
  const meta = (file: SentAttachment): string =>
    [file.size === undefined ? undefined : sizeLabel(file.size), kindLabel(file.name, file.type)]
      .filter((part) => part !== undefined)
      .join(" · ")
  const opens = (file: SentAttachment): boolean =>
    isOpenable(file) && (hasCardThumbnail(file) ? props.decoded(file) === "yes" : props.decoded(file) !== "no")
  return (
    <div class="@container w-full">
      <ul aria-label="Attachments" class="grid grid-cols-1 gap-2 @[400px]:grid-cols-2">
        <For each={props.attachments}>
          {(file, index) => (
            <li class="relative min-w-0">
              <div class={CARD}>
                <Show when={hasCardThumbnail(file)} fallback={<Thumbnail source={undefined} failed={false} />}>
                  <Tile
                    load={() => props.load(file)}
                    alt=""
                    fallback={<FileIcon size={16} stroke-width={1.5} />}
                    class="h-10 w-10 rounded-sm bg-muted text-icon"
                  />
                </Show>
                <Label name={file.name} meta={meta(file)} />
              </div>
              <Show when={opens(file)}>
                <button
                  type="button"
                  aria-label={`Open ${file.name}`}
                  class="im-press absolute inset-0 rounded-md outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-focus"
                  onClick={() => props.onOpen(index())}
                />
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

let lightboxLoader: Promise<typeof LightboxView> | undefined

type Opened = LightboxItem & { readonly file: SentAttachment }

/**
 * A sent message's files with the lightbox behind them, loaded on the first open so it stays out of the startup
 * bundle. Opening an image shows it beside every image of the message whose bytes have decoded, each URL from the
 * transcript's blob cache.
 */
export function SentAttachments(props: { attachments: readonly SentAttachment[] }): JSX.Element {
  const blobs = useSentBlobs()
  const [Lightbox, setLightbox] = createSignal<typeof LightboxView>()
  const [decoded, setDecoded] = createSignal<Readonly<Record<string, Decoded>>>({})
  const [items, setItems] = createSignal<readonly Opened[]>([])
  const [open, setOpen] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  const mark = (file: SentAttachment, state: Decoded): void => {
    const sha256 = file.sha256
    if (sha256 !== undefined) setDecoded((all) => ({ ...all, [sha256]: state }))
  }
  const stateOf = (file: SentAttachment): Decoded | undefined =>
    file.sha256 === undefined ? undefined : decoded()[file.sha256]
  const load = (file: SentAttachment): Promise<string> =>
    blobs
      .url(file.sha256 ?? "", file.type)
      .then(decodes)
      .then(
        (url) => {
          mark(file, "yes")
          return url
        },
        (failure: unknown) => {
          mark(file, "no")
          throw failure
        },
      )
  const show = async (pressed: SentAttachment): Promise<void> => {
    lightboxLoader ??= import("../ui/lightbox.tsx").then((module) => module.Lightbox)
    const shown = props.attachments.filter((file) => file === pressed || (isOpenable(file) && stateOf(file) === "yes"))
    const loaded = await Promise.allSettled(shown.map((file) => load(file).then((src) => ({ src, file }))))
    const opened = loaded.flatMap((result) =>
      result.status === "fulfilled"
        ? [{ src: result.value.src, name: result.value.file.name, size: result.value.file.size, type: result.value.file.type, file: result.value.file }]
        : [],
    )
    const at = opened.findIndex((item) => item.file === pressed)
    if (at < 0) return
    const view = await lightboxLoader
    setItems(opened)
    setIndex(at)
    setLightbox(() => view)
    setOpen(true)
  }
  return (
    <>
      <MessageAttachments
        attachments={props.attachments}
        decoded={stateOf}
        load={load}
        onOpen={(at) => {
          const pressed = props.attachments[at]
          if (pressed !== undefined) void show(pressed)
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
