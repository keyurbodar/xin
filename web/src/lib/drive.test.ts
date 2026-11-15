import { expect, test } from "bun:test"
import { OpError } from "./api.ts"
import {
  crumbsOf,
  folderOf,
  isStale,
  moveTarget,
  pickScope,
  reservedOf,
  resolveConflict,
  rowsOf,
  saveBlock,
  splitUploads,
  uploadPath,
  uploadSummary,
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

test("crumbs and folders are relative to the scope's root", () => {
  expect(crumbsOf("")).toEqual([])
  expect(crumbsOf("notes/research/")).toEqual([
    { name: "notes", path: "notes/" },
    { name: "research", path: "notes/research/" },
  ])
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

test("only a stale-base rejection counts as a conflict", () => {
  expect(isStale(new OpError("bad_args", "stale base: plan.md changed since a (now b)"))).toBe(true)
  expect(isStale(new OpError("bad_args", "no file plan.md"))).toBe(false)
  expect(isStale(new OpError("http", "stale base: x"))).toBe(false)
  expect(isStale(new Error("stale base: x"))).toBe(false)
})

test("Reload drops the edits; Overwrite writes them over the version now current", () => {
  expect(resolveConflict("reload", "mine", { sha256: "b" })).toEqual({ kind: "reload" })
  expect(resolveConflict("overwrite", "mine", { sha256: "b" })).toEqual({ kind: "write", text: "mine", base: "b" })
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
