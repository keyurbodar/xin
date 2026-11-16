import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import type { Page } from "playwright"
import { startHarness, type Harness } from "./harness.ts"

setDefaultTimeout(60_000)

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

const settled = (page: Page) => page.waitForTimeout(300)
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement
    return element?.closest("ui-tree-item")?.getAttribute("value") ?? element?.getAttribute("aria-label") ?? element?.textContent?.trim()
  })
const visibleRows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[role=treeitem]")]
      .filter((item) => item.checkVisibility())
      .map((item) => item.getAttribute("value"))
      .join(" "),
  )
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls.join(" "))

async function openTree(page: Page): Promise<void> {
  await page.waitForSelector("[role=treeitem]")
  await page.locator("[role=treeitem]").first().focus()
}

test("arrows expand a folder by loading it, enter it, and climb back out", async () => {
  const page = await harness.open("drive-view")
  await openTree(page)
  expect(await focused(page)).toBe("docs/")
  expect(await visibleRows(page)).toBe("docs/ skills/ src/ AGENTS.md notes.txt package.json README.md")
  await page.keyboard.press("ArrowRight")
  await settled(page)
  expect(await calls(page)).toContain("drive.list:docs/")
  expect(await page.getByRole("treeitem", { name: "docs" }).getAttribute("aria-expanded")).toBe("true")
  expect(await visibleRows(page)).toBe("docs/ docs/design/ docs/plan.md skills/ src/ AGENTS.md notes.txt package.json README.md")
  await page.keyboard.press("ArrowRight")
  expect(await focused(page)).toBe("docs/design/")
  await page.keyboard.press("ArrowLeft")
  expect(await focused(page)).toBe("docs/")
  await page.keyboard.press("ArrowLeft")
  await settled(page)
  expect(await visibleRows(page)).toBe("docs/ skills/ src/ AGENTS.md notes.txt package.json README.md")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.getByRole("treeitem", { name: "docs" }).getAttribute("aria-expanded")).toBe("true")
  await page.close()
})

test("Home, End and typeahead move through the visible rows", async () => {
  const page = await harness.open("drive-view")
  await openTree(page)
  await page.keyboard.press("End")
  expect(await focused(page)).toBe("README.md")
  await page.keyboard.press("Home")
  expect(await focused(page)).toBe("docs/")
  await page.keyboard.type("pa")
  expect(await focused(page)).toBe("package.json")
  await page.waitForTimeout(800)
  await page.keyboard.type("n")
  expect(await focused(page)).toBe("notes.txt")
  await page.close()
})

test("Enter opens a file and Back returns focus to its row", async () => {
  const page = await harness.open("drive-view")
  await openTree(page)
  await page.keyboard.type("notes")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.getByText("Ship the tree.").isVisible()).toBe(true)
  await page.getByRole("button", { name: "Back to the files" }).click()
  await settled(page)
  expect(await focused(page)).toBe("notes.txt")
  await page.close()
})

test("Shift+F10 opens the row menu on its first item and Escape returns to the row", async () => {
  const page = await harness.open("drive-view")
  await openTree(page)
  await page.keyboard.type("readme")
  await page.keyboard.press("Shift+F10")
  await settled(page)
  expect((await page.getByRole("menuitem").allTextContents()).map((text) => text.trim())).toEqual(["Open", "RenameF2", "Move…", "Delete"])
  expect(await focused(page)).toBe("Open")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("menu").isVisible()).toBe(false)
  expect(await focused(page)).toBe("README.md")
  await page.close()
})

test("a right-click opens the row's menu, and Rename edits in place until Escape", async () => {
  const page = await harness.open("drive-view")
  await page.waitForSelector("[role=treeitem]")
  await page.getByText("notes.txt").click({ button: "right" })
  await settled(page)
  await page.getByRole("menuitem", { name: "Rename" }).click()
  await settled(page)
  const field = page.getByRole("textbox", { name: "Rename notes.txt" })
  expect(await field.evaluate((input: HTMLInputElement) => input === document.activeElement && input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0))).toBe("notes")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await field.count()).toBe(0)
  expect(await focused(page)).toBe("notes.txt")
  expect(await calls(page)).not.toContain("drive.move")
  await page.close()
})

test("F2 renames a file, refusing a sibling's name, and Enter moves it", async () => {
  const page = await harness.open("drive-view")
  await openTree(page)
  await page.keyboard.type("notes")
  await page.keyboard.press("F2")
  await settled(page)
  await page.keyboard.press("Control+A")
  await page.keyboard.type("README.md")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.getByRole("alert").textContent()).toBe("README.md is already in this folder.")
  await page.keyboard.press("Control+A")
  await page.keyboard.type("todo.txt")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await calls(page)).toContain("drive.move")
  expect(await visibleRows(page)).toContain("todo.txt")
  expect(await focused(page)).toBe("todo.txt")
  await page.close()
})

test("the History toggle presses, and the version list selects with arrows", async () => {
  const page = await harness.open("drive-view")
  await page.waitForSelector("[role=treeitem]")
  await page.getByText("notes.txt").click()
  await settled(page)
  const history = page.getByRole("button", { name: "History" })
  await history.click()
  await settled(page)
  expect(await history.getAttribute("aria-pressed")).toBe("true")
  await page.getByRole("listbox", { name: "Earlier versions" }).focus()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.getByRole("option", { selected: true }).count()).toBe(1)
  expect(await page.getByRole("button", { name: "Restore this version" }).isVisible()).toBe(true)
  await history.click()
  await settled(page)
  expect(await history.getAttribute("aria-pressed")).toBe("false")
  expect(await page.getByRole("listbox").count()).toBe(0)
  await page.close()
})

test("the Move dialog's scope Select opens on the keyboard and closes on Escape without closing the dialog", async () => {
  const page = await harness.open("drive-view")
  await page.waitForSelector("[role=treeitem]")
  await page.getByText("notes.txt").click({ button: "right" })
  await settled(page)
  await page.getByRole("menuitem", { name: "Move…" }).click()
  await settled(page)
  const scope = page.getByRole("combobox", { name: "Scope" })
  await scope.focus()
  await page.keyboard.press("ArrowDown")
  await settled(page)
  expect(await page.getByRole("option").count()).toBe(2)
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("listbox").count()).toBe(0)
  expect(await page.getByRole("dialog", { name: "Move or rename" }).isVisible()).toBe(true)
  await page.close()
})

test("Upload files sends each picked file into the scope's root", async () => {
  const page = await harness.open("drive-view")
  const puts: string[] = []
  await page.route("**/files/**", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    puts.push(new URL(route.request().url()).pathname)
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })
  await page.waitForSelector("[role=treeitem]")
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: "Upload files" }).click()
  await (await chooser).setFiles([{ name: "brief.md", mimeType: "text/markdown", buffer: Buffer.from("# Brief") }])
  await settled(page)
  expect(puts).toEqual(["/files/projects/atlas/brief.md"])
  await page.close()
})
