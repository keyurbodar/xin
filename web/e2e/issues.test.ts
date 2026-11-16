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

const settled = (page: Page) => page.waitForTimeout(450)
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls.slice())
const sent = async (page: Page, op: string) => (await calls(page)).filter((call) => call.startsWith(`${op}:`))
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim())

async function open(view: "list" | "issue" | "crew", extra = ""): Promise<Page> {
  const page = await harness.open("issues", { search: `?view=${view}${extra}`, width: 900 })
  if (view === "list") await page.locator("[data-issue='1']").waitFor()
  if (view === "issue") await page.getByRole("button", { name: /^State: / }).waitFor()
  if (view === "crew") await page.getByRole("button", { name: "Add a thread to the crew" }).waitFor()
  await settled(page)
  return page
}

test("issue rows sit at the list-row height with no Ark parts on the issues, issue and crew views", async () => {
  for (const view of ["list", "issue", "crew"] as const) {
    const page = await open(view)
    expect(await page.locator("[data-scope]").count()).toBe(0)
    if (view === "list") {
      const heights = await page.locator("[data-issue]").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))
      expect(heights).toEqual([36, 36, 36, 36, 36])
    }
    await page.close()
  }
})

test("the closed toggle is a pressed toggle that adds the closed states", async () => {
  const page = await open("list")
  const toggle = page.getByRole("button", { name: "Closed issues" })
  expect(await toggle.getAttribute("aria-pressed")).toBe("false")
  await toggle.click()
  await page.locator("[data-issue='5']").waitFor()
  expect(await toggle.getAttribute("aria-pressed")).toBe("true")
  await toggle.click()
  await settled(page)
  expect(await page.locator("[data-issue='5']").count()).toBe(0)
  await page.close()
})

test("new issue opens from the keyboard, priority deselects on a second press, and Create sends the picks", async () => {
  const page = await open("list")
  await page.getByRole("button", { name: "New issue" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("dialog").waitFor()
  await settled(page)
  expect(await focusedLabel(page)).toBe("Issue title")
  await page.keyboard.type("Write the release notes")
  const high = page.getByRole("radio", { name: "High" })
  await high.click()
  expect(await high.getAttribute("aria-checked")).toBe("true")
  await high.click()
  expect(await high.getAttribute("aria-checked")).toBe("false")
  await page.getByRole("radio", { name: "Urgent" }).click()
  await page.getByRole("combobox", { name: "State" }).click()
  await page.getByRole("option", { name: "Needs you" }).click()
  await settled(page)
  await page.getByRole("button", { name: "Create" }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  const created = await sent(page, "issue.create")
  expect(created).toHaveLength(1)
  expect(JSON.parse(created[0]!.slice("issue.create:".length))).toMatchObject({
    title: "Write the release notes",
    project: "p1",
    priority: "urgent",
    state: "needs-you",
  })
  await page.close()
})

test("Escape closes new issue and returns focus to its trigger", async () => {
  const page = await open("list")
  await page.getByRole("button", { name: "New issue" }).click()
  await page.getByRole("dialog").waitFor()
  await settled(page)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await focusedLabel(page)).toBe("New issue")
  await page.close()
})

test("the state picker is a radio menu: arrows and Enter send one update and focus returns to it", async () => {
  const page = await open("issue")
  await page.getByRole("button", { name: "State: In progress" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menu").waitFor()
  expect(await page.getByRole("menuitemradio").allTextContents()).toEqual(["Needs you", "Todo", "In progress", "Done"])
  expect(await page.getByRole("menuitemradio", { name: "In progress" }).getAttribute("aria-checked")).toBe("true")
  await page.getByRole("menuitemradio", { name: "Done" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menu").waitFor({ state: "detached" })
  await page.getByRole("button", { name: "State: Done" }).waitFor()
  expect(await sent(page, "issue.update")).toEqual(['issue.update:{"id":1,"state":"done"}'])
  expect(await focusedLabel(page)).toBe("State: Done")
  await page.close()
})

test("the assignee search picks the first match on Enter and closes", async () => {
  const page = await open("issue")
  await page.getByRole("button", { name: "Add an assignee" }).click()
  await page.getByRole("dialog", { name: "Add an assignee" }).waitFor()
  await settled(page)
  expect(await focusedLabel(page)).toBe("Search assignees")
  await page.keyboard.type("review")
  await settled(page)
  await page.keyboard.press("Enter")
  await page.getByRole("dialog", { name: "Add an assignee" }).waitFor({ state: "detached" })
  const updates = await sent(page, "issue.update")
  expect(updates).toHaveLength(1)
  expect(updates[0]).toContain('{"kind":"thread","id":12}')
  await page.close()
})

test("add a link takes the kind from a segmented control and a typed #id on Enter", async () => {
  const page = await open("issue")
  await page.getByRole("button", { name: "Add a link" }).click()
  await page.getByRole("dialog", { name: "Add a link" }).waitFor()
  await settled(page)
  expect(await focusedLabel(page)).toBe("Find an issue to link")
  await page.getByRole("radio", { name: "Blocked by" }).click()
  expect(await page.getByRole("radio", { name: "Blocked by" }).getAttribute("aria-checked")).toBe("true")
  await page.getByLabel("Find an issue to link").focus()
  await page.keyboard.type("#6")
  await settled(page)
  await page.keyboard.press("Enter")
  await page.getByRole("dialog", { name: "Add a link" }).waitFor({ state: "detached" })
  expect(await sent(page, "issue.link")).toEqual(['issue.link:{"id":1,"kind":"blocked_by","other":6}'])
  await page.close()
})

test("add a link stays open with the refusal shown when the link fails", async () => {
  const page = await open("issue", "&fail=issue.link")
  await page.getByRole("button", { name: "Add a link" }).click()
  await page.getByRole("dialog", { name: "Add a link" }).waitFor()
  await settled(page)
  await page.keyboard.type("slow")
  await page.getByRole("option", { name: /Investigate the slow search/ }).waitFor()
  await page.keyboard.press("Enter")
  await page.getByRole("dialog", { name: "Add a link" }).getByRole("alert").waitFor()
  expect(await page.getByRole("dialog", { name: "Add a link" }).getByRole("alert").textContent()).toContain("refused by the fixture")
  await page.close()
})

test("the crew menu adds the chosen thread", async () => {
  const page = await open("crew")
  await page.getByRole("button", { name: "Add a thread to the crew" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menu").waitFor()
  await page.getByRole("menuitem", { name: "Draft the launch post" }).click()
  await page.getByRole("menu").waitFor({ state: "detached" })
  expect(await sent(page, "captain.crew.add")).toEqual(['captain.crew.add:{"id":"c1","threadId":31}'])
  await page.close()
})

const centre = async (page: Page, name: string) => {
  const box = await page.getByRole("button", { name }).boundingBox()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

test("the list view loads no popup elements until New issue or the closed toggle is used, and a bare click still opens", async () => {
  const page = await open("list")
  expect(await page.evaluate(() => ["ui-popover", "ui-select", "ui-radio-group", "ui-toggle", "ui-menu"].map((tag) => customElements.get(tag) !== undefined))).toEqual([
    false,
    false,
    false,
    false,
    false,
  ])
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("[aria-label='New issue']")!.click())
  await page.getByRole("dialog").waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("[aria-label='Closed issues']")!.click())
  await page.locator("[data-issue='5']").waitFor()
  expect(await page.getByRole("button", { name: "Closed issues" }).getAttribute("aria-pressed")).toBe("true")
  await page.close()
})

test("Space on the chosen priority clears it, as a second press does", async () => {
  const page = await open("list")
  await page.getByRole("button", { name: "New issue" }).click()
  await page.getByRole("dialog").waitFor()
  await settled(page)
  const high = page.getByRole("radio", { name: "High" })
  await high.focus()
  await page.keyboard.press("Space")
  expect(await high.getAttribute("aria-checked")).toBe("true")
  await page.keyboard.press("Space")
  expect(await high.getAttribute("aria-checked")).toBe("false")
  await page.close()
})

test("while a picked state saves, pressing either picker opens nothing and only one update goes out", async () => {
  const page = await open("issue", "&slow=1500")
  const state = await centre(page, "State: In progress")
  const priority = await centre(page, "Priority: High")
  await page.mouse.click(state.x, state.y)
  await page.getByRole("menuitemradio", { name: "Done" }).click()
  await page.getByRole("button", { name: "State: In progress", disabled: true }).waitFor()
  for (const at of [state, priority]) {
    await page.mouse.click(at.x, at.y)
    await page.waitForTimeout(150)
    expect(await page.getByRole("menu").count()).toBe(0)
  }
  await page.getByRole("button", { name: "State: Done" }).waitFor()
  expect(await sent(page, "issue.update")).toEqual(['issue.update:{"id":1,"state":"done"}'])
  await page.close()
})

test("while an assignee saves, Add an assignee opens nothing and only one update goes out", async () => {
  const page = await open("issue", "&slow=1500")
  await page.getByRole("button", { name: "Add an assignee" }).click()
  await page.getByRole("dialog", { name: "Add an assignee" }).waitFor()
  await settled(page)
  await page.keyboard.type("review")
  await settled(page)
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Add an assignee", disabled: true }).waitFor()
  const add = await centre(page, "Add an assignee")
  await page.mouse.click(add.x, add.y)
  await page.waitForTimeout(150)
  expect(await page.getByRole("dialog", { name: "Add an assignee" }).count()).toBe(0)
  await page.waitForTimeout(1800)
  expect(await sent(page, "issue.update")).toHaveLength(1)
  await page.close()
})

test("while a crew add saves, the add menu opens nothing and only one add goes out", async () => {
  const page = await open("crew", "&slow=1500")
  const add = await centre(page, "Add a thread to the crew")
  await page.mouse.click(add.x, add.y)
  await page.getByRole("menuitem", { name: "Draft the launch post" }).click()
  await page.getByRole("button", { name: "Add a thread to the crew", disabled: true }).waitFor()
  await page.mouse.click(add.x, add.y)
  await page.waitForTimeout(150)
  expect(await page.getByRole("menu").count()).toBe(0)
  await page.waitForTimeout(1800)
  expect(await sent(page, "captain.crew.add")).toEqual(['captain.crew.add:{"id":"c1","threadId":31}'])
  await page.close()
})

test("removing a second crew member while the first removal runs sends nothing more", async () => {
  const page = await open("crew", "&slow=1500")
  await page.getByRole("button", { name: "Remove Port the dialog shell from the crew" }).click()
  await page.getByRole("button", { name: "Remove Review the spec from the crew" }).click()
  await page.waitForTimeout(2200)
  expect(await sent(page, "captain.crew.remove")).toEqual(['captain.crew.remove:{"id":"c1","threadId":11}'])
  await page.close()
})

test("an aborted New issue or toggle chunk raises no unhandled rejection and the next press loads it", async () => {
  const aborted = new Set<string>()
  const page = await harness.open("issues", {
    search: "?view=list",
    width: 900,
    before: async (target) => {
      await target.addInitScript(() => {
        const seen: string[] = []
        Object.assign(window, { rejections: seen })
        window.addEventListener("unhandledrejection", (event) => seen.push(String(event.reason)))
      })
      await target.route(/new-issue\.tsx|ui-sdk_web_toggle|@ui-sdk\/web\/dist\/toggle/, async (route) => {
        const key = route.request().url().includes("new-issue") ? "new-issue" : "toggle"
        if (aborted.has(key)) return route.continue()
        aborted.add(key)
        return route.abort()
      })
    },
  })
  await page.locator("[data-issue='1']").waitFor()
  const rejections = () => page.evaluate(() => (window as unknown as { rejections: string[] }).rejections)
  await page.getByRole("button", { name: "New issue" }).hover()
  await page.getByRole("button", { name: "Closed issues" }).focus()
  await page.waitForTimeout(600)
  expect([...aborted].sort()).toEqual(["new-issue", "toggle"])
  expect(await rejections()).toEqual([])
  expect(await page.getByRole("dialog").count()).toBe(0)
  await page.getByRole("button", { name: "New issue" }).click()
  await page.getByRole("dialog").waitFor()
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Closed issues" }).click()
  await page.locator("[data-issue='5']").waitFor()
  expect(await rejections()).toEqual([])
  await page.close()
})

test("a double press while the New issue and toggle chunks load opens New issue once and turns the toggle on once", async () => {
  const page = await harness.open("issues", {
    search: "?view=list",
    width: 900,
    before: (target) =>
      target.route(/new-issue\.tsx|ui-sdk_web_toggle|@ui-sdk\/web\/dist\/toggle/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await route.continue()
      }),
  })
  await page.locator("[data-issue='1']").waitFor()
  const doublePress = (label: string) =>
    page.evaluate((name) => {
      const button = document.querySelector<HTMLButtonElement>(`[aria-label='${name}']`)!
      button.click()
      button.click()
    }, label)
  await doublePress("New issue")
  await page.getByRole("dialog").waitFor()
  await page.waitForTimeout(1200)
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await doublePress("Closed issues")
  await page.waitForTimeout(2200)
  expect(await page.getByRole("button", { name: "Closed issues" }).getAttribute("aria-pressed")).toBe("true")
  await page.locator("[data-issue='5']").waitFor()
  await page.close()
})
