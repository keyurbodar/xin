import { withoutWallpaper, type Appearance, type Wallpaper } from "./model.ts"

export type WallpaperFiles = {
  readonly unshare: (path: string) => Promise<unknown>
  readonly remove: (path: string) => Promise<unknown>
  readonly edit: (change: (current: Appearance) => Appearance) => void
}

/** Revokes the wallpaper's share link and deletes its file before forgetting it, so a removed wallpaper stops being public. */
export async function forgetWallpaper(wallpaper: Wallpaper, files: WallpaperFiles): Promise<void> {
  if (wallpaper.path !== undefined) {
    await files.unshare(wallpaper.path)
    await files.remove(wallpaper.path)
  }
  files.edit((current) => withoutWallpaper(current, wallpaper.url))
}
