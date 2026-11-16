import { createResource, For, onCleanup, Show, type JSX } from "solid-js"
import { ArrowUpRight, ChevronRight } from "lucide-solid"
import { createBlobCache } from "../../lib/blob-cache.ts"
import { folderOf, hasTreeThumbnail } from "../../lib/drive.ts"
import { fileIconUrl } from "../../lib/file-icons.ts"
import { settled } from "../../lib/loading.ts"
import { theme } from "../../lib/theme.ts"
import { showPaneView } from "../../state/tabs.ts"
import { ICON_BUTTON } from "../shell/menu.ts"
import { Tile } from "../ui/tile.tsx"
import { fileName, recentProjectFiles } from "./bodies.tsx"
import { fileView, Section, type PaneContext } from "./overview.tsx"

const DRIVE_TILES = 8
const TILE = "aspect-[3/4] w-full rounded-md border border-line-1 bg-secondary"

const icon = (path: string): JSX.Element => (
  <img src={fileIconUrl(fileName(path), false, theme() === "light" ? "light" : "dark")} alt="" width={24} height={24} draggable={false} class="size-6" />
)

/** The project's newest files as a strip of tiles, pictures as themselves, then Show more for the whole Drive. */
export function DriveSection(props: PaneContext & { label: string }): JSX.Element {
  const [listing] = createResource(() => props.project.slug, recentProjectFiles)
  const files = () => settled(listing)?.files
  const blobs = createBlobCache()
  onCleanup(blobs.clear)
  const openDrive = (): void => showPaneView(props.project.id, "files")
  return (
    <Section
      label={props.label}
      count={files()?.length ?? 0}
      action={
        <button type="button" class={ICON_BUTTON} aria-label="Open Drive" onClick={openDrive}>
          <ArrowUpRight size={14} stroke-width={1.5} />
        </button>
      }
    >
      <Show
        when={(files()?.length ?? 0) > 0}
        fallback={<span class="px-2 py-1.5 text-sm text-ink-3">{listing.loading ? "Loading files" : listing.error === undefined ? "No files yet" : "Drive is unavailable"}</span>}
      >
        <div class="flex gap-2 overflow-x-auto px-2 pb-1 pt-0.5" role="list" aria-label="Newest files">
          <For each={(files() ?? []).slice(0, DRIVE_TILES)}>
            {(entry) => (
              <button
                type="button"
                role="listitem"
                onClick={() => showPaneView(props.project.id, fileView(entry.path))}
                class="im-press flex w-[96px] shrink-0 flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-soft"
              >
                <Show when={hasTreeThumbnail(entry)} fallback={<span class={`grid place-items-center ${TILE}`}>{icon(entry.path)}</span>}>
                  <Tile load={() => blobs.url(entry.sha256, entry.type)} alt="" fallback={icon(entry.path)} class={TILE} />
                </Show>
                <span class="truncate text-xs text-ink-2">{fileName(entry.path)}</span>
                <span class="-mt-1 truncate text-2xs text-ink-3">{folderOf(entry.path).replace(/\/$/u, "") || "Drive"}</span>
              </button>
            )}
          </For>
          <Show when={(files()?.length ?? 0) > DRIVE_TILES}>
            <button
              type="button"
              onClick={openDrive}
              class="im-press flex aspect-[3/4] w-[96px] shrink-0 flex-col items-center justify-center gap-1 rounded-md bg-secondary text-xs text-ink-3 hover:text-ink-2"
            >
              <ChevronRight size={14} stroke-width={1.5} />
              Show more
            </button>
          </Show>
        </div>
      </Show>
    </Section>
  )
}
