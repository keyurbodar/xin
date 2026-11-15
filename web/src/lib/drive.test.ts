import { expect, test } from "bun:test"
import { OpError } from "./api.ts"
import {
  createRetryIds,
  crumbsOf,
  failureText,
  folderOf,
  moveTarget,
  pickScope,
  reservedOf,
  rowsOf,
  shareUrl,
  uploadPath,
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
