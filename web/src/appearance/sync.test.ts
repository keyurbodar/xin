import { expect, test } from "bun:test"
import { OpError } from "../lib/api.ts"
import { DEFAULT_APPEARANCE, type Appearance } from "./model.ts"
import { createSync, type HomeCopy, type Sync } from "./sync.ts"

type Home = { doc: string | null; rev: number; reads: number; writes: number }

const newHome = (): Home => ({ doc: null, rev: 0, reads: 0, writes: 0 })

type Tab = { readonly sync: Sync; shown: Appearance; status: string }

/** One tab on one home; tabs given the same `peers` list hear each other's broadcasts, as tabs in one browser do. */
function openTab(home: Home, peers: Tab[] = [], start: Appearance = DEFAULT_APPEARANCE): Tab {
  const tab: Tab = {
    shown: start,
    status: "idle",
    sync: createSync({
      read: async (): Promise<HomeCopy> => {
        home.reads += 1
        return { doc: home.doc, rev: home.rev }
      },
      write: async (doc, rev) => {
        if (rev !== home.rev) throw new OpError("busy", `appearance changed elsewhere (rev ${home.rev})`)
        home.writes += 1
        home.doc = doc
        home.rev += 1
        return { rev: home.rev }
      },
      current: () => tab.shown,
      show: (next) => {
        tab.shown = next
      },
      broadcast: (message) => {
        for (const peer of peers) if (peer !== tab) peer.sync.receive(structuredClone(message))
      },
      status: (state) => {
        tab.status = state
      },
    }),
  }
  peers.push(tab)
  return tab
}

const sidebar = (value: number) => (current: Appearance): Appearance => ({ ...current, ui: { ...current.ui, sidebar: value } })
const pane = (value: number) => (current: Appearance): Appearance => ({ ...current, ui: { ...current.ui, pane: value } })
const stored = (home: Home): Appearance["ui"] | undefined => (home.doc === null ? undefined : JSON.parse(home.doc).ui)

test("two tabs editing in turn both land, and both tabs show the last edit", async () => {
  const home = newHome()
  const tabs: Tab[] = []
  const [a, b] = [openTab(home, tabs), openTab(home, tabs)]
  await Promise.all([a.sync.pull(), b.sync.pull()])

  a.sync.edit(sidebar(252))
  await a.sync.save()
  b.sync.edit(sidebar(240))
  await b.sync.save()

  expect(stored(home)?.sidebar).toBe(240)
  expect([a.shown.ui.sidebar, b.shown.ui.sidebar]).toEqual([240, 240])
  expect(home.writes).toBe(2)
})

test("a save that loses the race re-reads, replays its edit onto the winner and saves again", async () => {
  const home = newHome()
  const tabs: Tab[] = []
  const [a, b] = [openTab(home, tabs), openTab(home, tabs)]
  await Promise.all([a.sync.pull(), b.sync.pull()])

  a.sync.edit(sidebar(300))
  b.sync.edit(pane(400))
  await Promise.all([a.sync.save(), b.sync.save()])

  expect(stored(home)).toMatchObject({ sidebar: 300, pane: 400 })
  expect(home.writes).toBe(2)
  expect([a.status, b.status]).toEqual(["saved", "saved"])
})

test("a device that read an old copy changes only what it edited when it saves", async () => {
  const home = newHome()
  const laptop = openTab(home)
  await laptop.sync.pull()
  const phone = openTab(home)
  await phone.sync.pull()
  phone.sync.edit(sidebar(220))
  await phone.sync.save()

  laptop.sync.edit(pane(400))
  await laptop.sync.save()

  expect(stored(home)).toMatchObject({ sidebar: 220, pane: 400 })
  expect(laptop.shown.ui).toMatchObject({ sidebar: 220, pane: 400 })
})

test("a device that never reached the home reads it before its first save instead of saving blind", async () => {
  const home = newHome()
  const phone = openTab(home)
  phone.sync.edit(sidebar(220))
  await phone.sync.save()
  const offline = openTab(home)

  offline.sync.edit(pane(400))
  await offline.sync.save()

  expect(stored(home)).toMatchObject({ sidebar: 220, pane: 400 })
})

test("a read that lands while an edit is unsaved keeps the edit", async () => {
  const home = newHome()
  const other = openTab(home)
  other.sync.edit(sidebar(220))
  await other.sync.save()
  const tab = openTab(home)

  tab.sync.edit(pane(400))
  await tab.sync.pull()

  expect(tab.shown.ui).toMatchObject({ sidebar: 220, pane: 400 })
  await tab.sync.save()
  expect(stored(home)).toMatchObject({ sidebar: 220, pane: 400 })
})

test("a tab learns each saved revision from the others, so its next save is not refused", async () => {
  const home = newHome()
  const tabs: Tab[] = []
  const [a, b] = [openTab(home, tabs), openTab(home, tabs)]
  await Promise.all([a.sync.pull(), b.sync.pull()])
  a.sync.edit(sidebar(252))
  await a.sync.save()
  const reads = home.reads

  b.sync.edit(pane(400))
  await b.sync.save()

  expect(home.reads).toBe(reads)
  expect(stored(home)).toMatchObject({ sidebar: 252, pane: 400 })
})

test("a device that opted out of sync never writes the home", async () => {
  const home = newHome()
  const tab = openTab(home, [], { ...DEFAULT_APPEARANCE, sync: "device" })
  tab.sync.edit(sidebar(300))
  await tab.sync.save()
  await tab.sync.pull()

  expect(home.writes).toBe(0)
  expect(tab.shown.ui.sidebar).toBe(300)
})

test("an empty home takes this device's settings on the first pull", async () => {
  const home = newHome()
  const tab = openTab(home, [], { ...DEFAULT_APPEARANCE, mode: "light" })
  await tab.sync.pull()

  expect(home.doc === null ? undefined : JSON.parse(home.doc).mode).toBe("light")
})
