import { expect, test } from "bun:test"
import { OpError } from "./api.ts"
import {
  copyLink,
  createRetryIds,
  failureText,
  folderOf,
  hasThumbnail,
  hasTreeThumbnail,
  TREE_THUMBNAIL_BYTES,
  isStale,
  moveTarget,
  pickScope,
  renameProblem,
  reservedOf,
  resolveConflict,
  rowsOf,
  saveBlock,
  shareUrl,
  splitUploads,
  uploadPath,
  uploadSummary,
  writeArgs,
  type DriveEntry,
  type MountedScope,
} from "./drive.ts"

const entry = (path: string): DriveEntry => ({ path, size: 1, type: "text/plain", sha256: "0".repeat(64), updated_at: 1 })

const SCOPES: readonly MountedScope[] = [
  { scope: { kind: "user" }, root: "/me/", label: "user" },
  { scope: { kind: "project", id: "prj_1" }, root: "/projects/atlas/", label: "project atlas" },
  { scope: { kind: "captain", id: "cap_1" }, root: "/captains/cap_1/", label: "captain cap_1" },
  { scope: { kind: "automation", id: "aut_1" }, root: "/automations/aut_1/", label: "automation aut_1" },
]

test("reserved paths are AGENTS.md at the root and skills/<name>/SKILL.md", () => {
  expect(reservedOf("AGENTS.md")).toEqual({ kind: "instructions" })
  expect(reservedOf("notes/AGENTS.md")).toBeUndefined()
  expect(reservedOf("skills/launch-checklist/SKILL.md")).toEqual({ kind: "skill", name: "launch-checklist" })
  expect(reservedOf("skills/Bad_Name/SKILL.md")).toBeUndefined()
  expect(reservedOf("skills/a/b/SKILL.md")).toBeUndefined()
})

test("a folder lists its subfolders with counts, then its own files, by name", () => {
  const files = [entry("b.txt"), entry("notes/plan.md"), entry("notes/research/x.txt"), entry("a.md"), entry("skills/s/SKILL.md")]
  expect(rowsOf(files, "").map((row) => (row.kind === "folder" ? `${row.name}/${row.files}` : row.name))).toEqual([
    "notes/2",
    "skills/1",
    "a.md",
    "b.txt",
  ])
  expect(rowsOf(files, "notes/").map((row) => (row.kind === "folder" ? row.path : row.entry.path))).toEqual([
    "notes/research/",
    "notes/plan.md",
  ])
})

test("folders are relative to the scope's root", () => {
  expect(folderOf("AGENTS.md")).toBe("")
  expect(folderOf("notes/research/x.txt")).toBe("notes/research/")
})

test("the view keeps the picked scope, else the pane's own, else the project", () => {
  expect(pickScope(SCOPES, "/me/", { kind: "project", id: "prj_1" })?.root).toBe("/me/")
  expect(pickScope(SCOPES, undefined, { kind: "captain", id: "cap_1" })?.root).toBe("/captains/cap_1/")
  expect(pickScope(SCOPES, "/gone/", { kind: "captain", id: "cap_9" })?.root).toBe("/projects/atlas/")
  expect(pickScope(SCOPES.slice(0, 1), undefined, { kind: "project", id: "prj_1" })?.root).toBe("/me/")
  expect(pickScope([], undefined, { kind: "user" })).toBeUndefined()
})

test("a move needs a file path that differs from the source", () => {
  expect(moveTarget("  /notes/launch.md ", "notes/plan.md", true)).toBe("notes/launch.md")
  expect(moveTarget("notes/plan.md", "notes/plan.md", true)).toBeUndefined()
  expect(moveTarget("notes/plan.md", "notes/plan.md", false)).toBe("notes/plan.md")
  expect(moveTarget(" ", "a", true)).toBeUndefined()
  expect(moveTarget("notes/", "a", true)).toBeUndefined()
})

test("an upload lands in the open folder under its own name", () => {
  expect(uploadPath("/projects/atlas/", "notes/", "upload me.txt")).toBe("/projects/atlas/notes/upload me.txt")
  expect(uploadPath("/me/", "", "a/b.txt")).toBe("/me/a-b.txt")
})

test("a share link is the id and the file's own name on the app's origin", () => {
  expect(shareUrl("https://ingle.example", "ab12", "notes/launch plan.md")).toBe("https://ingle.example/s/ab12/launch%20plan.md")
  expect(shareUrl("http://127.0.0.1:5243", "ab12", "budget.json")).toBe("http://127.0.0.1:5243/s/ab12/budget.json")
})

test("a rejection reads in the host's words; a lost answer says a retry is safe", () => {
  expect(failureText(new OpError("bad_args", "cannot move a: it is missing or b exists"))).toBe("cannot move a: it is missing or b exists")
  expect(failureText(new OpError("http", "drive.share: HTTP 502"))).toBe("drive.share: HTTP 502. Try again; a retry lands once.")
})

test("a command id is reused only while the args are unchanged and no ack came back", () => {
  let n = 0
  const ids = createRetryIds(() => `id${++n}`)
  const args = { scope: { kind: "user" }, path: "a.md", text: "x" }
  expect(ids.idFor("drive.write", args)).toBe("id1")
  ids.settle("drive.write", new OpError("http", "drive.write: HTTP 502"))
  expect(ids.idFor("drive.write", { ...args })).toBe("id1")
  expect(ids.idFor("drive.write", { ...args, text: "y" })).toBe("id2")
  ids.settle("drive.write", new OpError("bad_args", "no"))
  expect(ids.idFor("drive.write", { ...args, text: "y" })).toBe("id3")
  ids.settle("drive.write")
  expect(ids.idFor("drive.write", { ...args, text: "y" })).toBe("id4")
  expect(ids.idFor("drive.share", { scope: { kind: "user" }, path: "a.md" })).toBe("id5")
})

test("only a stale-base rejection counts as a conflict", () => {
  expect(isStale(new OpError("bad_args", "stale base: plan.md changed since a (now b)"))).toBe(true)
  expect(isStale(new OpError("bad_args", "no file plan.md"))).toBe(false)
  expect(isStale(new OpError("http", "stale base: x"))).toBe(false)
  expect(isStale(new Error("stale base: x"))).toBe(false)
  expect(isStale(new Error("stale base: x", { cause: new OpError("bad_args", "stale base: x") }))).toBe(true)
})

test("Save sends the sha the file was opened at as base, and Overwrite sends the sha now current", () => {
  const scope = { kind: "project", id: "acme" } as const
  const save = writeArgs(scope, "plan.md", "mine", { sha256: "opened" })
  expect(save).toEqual({ scope, path: "plan.md", text: "mine", base: "opened" })
  expect(writeArgs(scope, "new.md", "mine", undefined)).toEqual({ scope, path: "new.md", text: "mine" })
  expect(resolveConflict("reload", save, { sha256: "current" })).toEqual({ kind: "reload" })
  expect(resolveConflict("overwrite", save, { sha256: "current" })).toEqual({
    kind: "write",
    write: { scope, path: "plan.md", text: "mine", base: "current" },
  })
})

test("AGENTS.md over the cap cannot be saved; other files and a short AGENTS.md can", () => {
  expect(saveBlock("AGENTS.md", "x".repeat(20_000))).toBeUndefined()
  expect(saveBlock("AGENTS.md", "x".repeat(20_001))).toContain("20,001 characters")
  expect(saveBlock("notes/AGENTS.md", "x".repeat(30_000))).toBeUndefined()
  expect(saveBlock("plan.md", "x".repeat(30_000))).toBeUndefined()
})

test("files over the limit stay in the browser and are named with any that failed", () => {
  const files = [{ name: "a.txt", size: 10 }, { name: "big.bin", size: 11 }, { name: "c.txt", size: 10 }]
  const split = splitUploads(files, 10)
  expect(split.send.map((file) => file.name)).toEqual(["a.txt", "c.txt"])
  expect(split.tooBig.map((file) => file.name)).toEqual(["big.bin"])
  expect(uploadSummary([], [])).toBeUndefined()
  expect(uploadSummary(["big.bin"], ["c.txt"], 50 * 1024 * 1024)).toBe("Over 50.0 MB, not sent: big.bin. Failed to upload: c.txt.")
})

test("a share link is copied when the clipboard takes it, and left to copy by hand when it is missing or refused", async () => {
  const written: string[] = []
  expect(await copyLink("https://ingle.example/s/ab12/a.md", async (text) => void written.push(text))).toBe("copied")
  expect(written).toEqual(["https://ingle.example/s/ab12/a.md"])
  expect(await copyLink("https://ingle.example/s/ab12/a.md", undefined)).toBe("manual")
  expect(
    await copyLink("https://ingle.example/s/ab12/a.md", () => Promise.reject(new DOMException("denied", "NotAllowedError"))),
  ).toBe("manual")
})

test("a rename refuses empty names, slashes, dot names and a sibling's name in any case", () => {
  const siblings = ["plan.md", "Notes.txt"]
  expect(renameProblem("  ", "plan.md", siblings)).toBe("Give it a name.")
  expect(renameProblem("a/b.md", "plan.md", siblings)).toBe("A name can't hold a slash.")
  expect(renameProblem("..", "plan.md", siblings)).toBe(".. is reserved.")
  expect(renameProblem("notes.TXT", "plan.md", siblings)).toBe("Notes.txt is already in this folder.")
  expect(renameProblem("Plan.md", "plan.md", siblings)).toBeUndefined()
  expect(renameProblem("roadmap.md", "plan.md", siblings)).toBeUndefined()
})

test("raster images get a thumbnail, other files keep their icon", () => {
  expect(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].every(hasThumbnail)).toBe(true)
  expect(["image/svg+xml", "text/markdown", "application/pdf", "image/png-ish"].some(hasThumbnail)).toBe(false)
})

test("the tree shows an image's own thumbnail only up to 1 MB", () => {
  const image = (size: number) => ({ path: "a.png", size, type: "image/png", sha256: "a", updated_at: 0 })
  expect(hasTreeThumbnail(image(TREE_THUMBNAIL_BYTES))).toBe(true)
  expect(hasTreeThumbnail(image(TREE_THUMBNAIL_BYTES + 1))).toBe(false)
})
