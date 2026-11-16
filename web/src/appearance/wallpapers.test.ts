import { expect, test } from "bun:test"
import { DEFAULT_APPEARANCE, type Appearance, type Wallpaper } from "./model.ts"
import { forgetWallpaper } from "./wallpapers.ts"

const WALL: Wallpaper = { name: "wall.png", url: "/s/abc/wall.png", path: "appearance/wallpapers/wall.png" }
const OTHER: Wallpaper = { name: "other.png", url: "/s/def/other.png", path: "appearance/wallpapers/other.png" }

function files(fail?: "unshare" | "remove") {
  const calls: string[] = []
  let shown: Appearance = { ...DEFAULT_APPEARANCE, background: { ...DEFAULT_APPEARANCE.background, image: WALL }, wallpapers: [WALL, OTHER] }
  return {
    calls,
    shown: () => shown,
    port: {
      unshare: async (path: string) => {
        calls.push(`unshare ${path}`)
        if (fail === "unshare") throw new Error("offline")
      },
      remove: async (path: string) => {
        calls.push(`remove ${path}`)
        if (fail === "remove") throw new Error("offline")
      },
      edit: (change: (current: Appearance) => Appearance) => {
        shown = change(shown)
      },
    },
  }
}

test("Remove revokes the share link and deletes the file, then forgets the wallpaper everywhere it is used", async () => {
  const world = files()
  await forgetWallpaper(WALL, world.port)
  expect(world.calls).toEqual([`unshare ${WALL.path}`, `remove ${WALL.path}`])
  expect(world.shown().wallpapers).toEqual([OTHER])
  expect(world.shown().background.image).toBeUndefined()
})

test("a wallpaper whose link could not be revoked stays listed, so the owner can try again", async () => {
  const world = files("unshare")
  await expect(forgetWallpaper(WALL, world.port)).rejects.toThrow("offline")
  expect(world.calls).toEqual([`unshare ${WALL.path}`])
  expect(world.shown().wallpapers).toEqual([WALL, OTHER])
})

test("removing a wallpaper that is not in use leaves the background alone", async () => {
  const world = files()
  await forgetWallpaper(OTHER, world.port)
  expect(world.shown().background.image).toEqual(WALL)
  expect(world.shown().wallpapers).toEqual([WALL])
})
