import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import type { Page, Route } from "playwright"
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
    return element?.getAttribute("aria-label") ?? element?.textContent?.trim() ?? ""
  })
const chips = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("[data-slot=token-input-token]")].map((chip) => chip.textContent?.trim() ?? ""))
const editor = (page: Page) => page.getByRole("textbox", { name: "Message Ingle" })

test("the + menu moves with arrows, opens a kind with ArrowRight into its search, and Escape closes one level at a time", async () => {
  const page = await harness.open("composer")
  const add = page.getByRole("button", { name: "Add" })
  await add.click()
  await settled(page)
  await page.keyboard.press("ArrowDown")
  expect(await focused(page)).toContain("Upload attachment")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  expect(await focused(page)).toContain("Skills")
  await page.keyboard.press("ArrowRight")
  await settled(page)
  expect(await focused(page)).toBe("Search skills")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await focused(page)).toContain("Skills")
  expect(await page.getByRole("menu").count()).toBe(1)
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("menu").count()).toBe(0)
  expect(await add.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.close()
})

test("choosing from a + menu kind inserts its chip and the draft sends its backend text", async () => {
  const page = await harness.open("composer")
  await page.getByRole("button", { name: "Add" }).click()
  await settled(page)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowRight")
  await settled(page)
  await page.keyboard.type("review")
  await settled(page)
  expect((await page.getByRole("option").allTextContents()).map((text) => text.trim())).toEqual(["Review the specwaiting"])
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.getByRole("menu").count()).toBe(0)
  expect(await chips(page)).toEqual(["Review the spec"])
  expect(await focused(page)).toBe("Message Ingle")
  await page.keyboard.type("please")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("@thread:12 please")
  await page.close()
})

test("@ and / open suggestions in the editor and the choice becomes a chip", async () => {
  const page = await harness.open("composer")
  await editor(page).click()
  await page.keyboard.type("/is")
  await settled(page)
  expect(await page.getByRole("option", { name: /issues/ }).count()).toBe(1)
  await page.keyboard.press("Enter")
  await page.keyboard.type("for @notes")
  await settled(page)
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await chips(page)).toEqual(["issues", "notes.md"])
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("@skill:issues for @/projects/ingle/notes.md")
  await page.close()
})

test("pasted text that looks like references stays plain text", async () => {
  const page = await harness.open("composer")
  await editor(page).click()
  await editor(page).evaluate((element) => {
    const data = new DataTransfer()
    data.setData("text/plain", "@/etc/passwd and @thread:5")
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await settled(page)
  expect(await chips(page)).toEqual([])
  expect((await editor(page).textContent())?.replace(/\u200b/gu, "")).toBe("@/etc/passwd and @thread:5")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("@/etc/passwd and @thread:5")
  await page.close()
})

test("a + menu kind with nothing to offer is hidden", async () => {
  const page = await harness.open("composer", { search: "?empty=prompt.list" })
  await page.getByRole("button", { name: "Add" }).click()
  await settled(page)
  const kinds = (await page.getByRole("menuitem").allTextContents()).map((text) => text.trim())
  expect(kinds.slice(1)).toEqual(["Threads", "Skills", "Files"])
  await page.close()
})

test("a /prompt chip sends /name at the start, and one from the + menu replaces the draft's leading prompt", async () => {
  const page = await harness.open("composer")
  await editor(page).click()
  await page.keyboard.type("/fi")
  await settled(page)
  await page.keyboard.press("Enter")
  await page.keyboard.type("the login test")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("/fix the login test")
  await page.getByRole("button", { name: "Stop the run" }).click()
  await settled(page)
  await editor(page).click()
  await page.keyboard.type("/shi")
  await settled(page)
  await page.keyboard.press("Enter")
  await page.keyboard.type("it now")
  expect(await chips(page)).toEqual(["/ship"])
  await page.getByRole("button", { name: "Add" }).click()
  await settled(page)
  for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowRight"]) await page.keyboard.press(key)
  await settled(page)
  expect(await focused(page)).toBe("Search prompts")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await chips(page)).toEqual(["/fix"])
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("/fix it now")
  await page.close()
})

test("an empty conversation shows its project above the card, and a started one does not", async () => {
  const fresh = await harness.open("composer")
  expect(await fresh.getByRole("group", { name: "Thread scope" }).textContent()).toBe("Ingle")
  await fresh.close()
  const started = await harness.open("composer", { search: "?fresh=0" })
  expect(await started.getByRole("group", { name: "Thread scope" }).count()).toBe(0)
  await started.close()
})

test("Backspace removes a chip as one unit", async () => {
  const page = await harness.open("composer")
  await editor(page).click()
  await page.keyboard.type("see @rev")
  await settled(page)
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await chips(page)).toEqual(["Review the spec"])
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Backspace")
  await settled(page)
  expect(await chips(page)).toEqual([])
  expect((await editor(page).textContent())?.replace(/\u200b/gu, "")).toBe("see ")
  await page.close()
})

test("Shift+Enter breaks the line, Enter sends, and send becomes Stop while the run streams", async () => {
  const page = await harness.open("composer")
  await editor(page).click()
  await page.keyboard.type("hello")
  await page.keyboard.press("Shift+Enter")
  await page.keyboard.type("there")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("hello\nthere")
  expect(await focused(page)).toBe("Message Ingle")
  const stop = page.getByRole("button", { name: "Stop the run" })
  expect(await stop.count()).toBe(1)
  await stop.click()
  await settled(page)
  expect(await page.getByRole("button", { name: "Send message" }).isDisabled()).toBe(true)
  await page.close()
})

test("the model picker searches, picks with the keyboard, and mod+D favourites the highlighted model", async () => {
  const page = await harness.open("composer")
  await page.getByRole("button", { name: "Model: Opus Test" }).click()
  await settled(page)
  expect(await focused(page)).toBe("Search models")
  await page.keyboard.press("ControlOrMeta+d")
  await settled(page)
  expect(await page.getByRole("group", { name: "Favourites" }).getByRole("option").allTextContents()).toHaveLength(1)
  await page.keyboard.type("gpt")
  await settled(page)
  const options = await page.getByRole("option").allTextContents()
  expect(options.map((text) => text.trim())).toEqual(["OpGPT Test"])
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#model")).toBe("gpt")
  expect(await page.getByRole("listbox").count()).toBe(0)
  await page.getByRole("button", { name: "Model: GPT Test" }).click()
  await settled(page)
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("listbox").count()).toBe(0)
  expect(await focused(page)).toBe("Model: GPT Test")
  await page.close()
})

test("the reasoning menu is a radio group that keeps the menu open on a choice", async () => {
  const page = await harness.open("composer")
  await page.getByRole("button", { name: "Medium" }).click()
  await settled(page)
  expect(await page.getByRole("menuitemradio", { name: "Medium" }).getAttribute("aria-checked")).toBe("true")
  await page.getByRole("menuitemradio", { name: "High" }).click()
  await settled(page)
  expect(await page.textContent("#effort")).toBe("high")
  expect(await page.getByRole("menuitemradio", { name: "High" }).getAttribute("aria-checked")).toBe("true")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("menu").count()).toBe(0)
  await page.close()
})

const LAZY_FAMILIES = ["combobox", "menu", "command", "token-input", "trigger-menu"]
const LAZY_CONTENT = "ui-combobox-content, ui-menu-content, ui-menu-sub-content, ui-trigger-menu-content"

test("held UI SDK chunks leave every lazy popup part without a box, and the pickers open once they land", async () => {
  const held: Route[] = []
  const pattern = new RegExp(`/\\.vite/deps/@ui-sdk_web_(${LAZY_FAMILIES.join("|")})\\.js`)
  const page = await harness.open("composer", { before: (page) => page.route(pattern, (route) => void held.push(route)) })
  try {
    await page.waitForFunction(() => document.querySelector("ui-combobox-content") !== null && document.querySelector("ui-menu-content") !== null)
    await settled(page)
    const boxed = await page.evaluate((selector) => {
      const parts = [...document.querySelectorAll(selector)]
      return {
        parts: parts.length,
        defined: parts.filter((part) => customElements.get(part.localName) !== undefined).map((part) => part.localName),
        boxed: parts
          .filter((part) => [part, ...part.querySelectorAll("*")].some((node) => node.getClientRects().length > 0))
          .map((part) => part.localName),
      }
    }, LAZY_CONTENT)
    expect(boxed.parts).toBeGreaterThanOrEqual(2)
    expect(boxed.defined).toEqual([])
    expect(boxed.boxed).toEqual([])
    await Promise.all(held.map((route) => route.continue()))
    await page.unroute(pattern)
    await page.getByRole("button", { name: "Model: Opus Test" }).click()
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: 5000 })
    await settled(page)
    expect(await focused(page)).toBe("Search models")
    await page.keyboard.press("Escape")
    await settled(page)
    await page.getByRole("button", { name: "Medium" }).click()
    await page.getByRole("menu").waitFor({ state: "visible", timeout: 5000 })
    expect(await page.getByRole("menuitemradio", { name: "Medium" }).getAttribute("aria-checked")).toBe("true")
  } finally {
    await page.close()
  }
})

test("an input method composition after select-all and delete commits only its own text", async () => {
  const page = await harness.open("composer")
  await editor(page).click()
  await page.keyboard.type("hello")
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.press("Backspace")
  await settled(page)
  const cdp = await page.context().newCDPSession(page)
  for (const text of ["に", "にほ"]) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length })
  await cdp.send("Input.insertText", { text: "日本" })
  await settled(page)
  expect(await editor(page).textContent()).toBe("日本")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("日本")
  await cdp.detach()
  await page.close()
})

test("a plugin composer action inserts its text with a separating space after a word", async () => {
  const page = await harness.open("composer", { search: "?plugin=standup" })
  await editor(page).click()
  await page.keyboard.type("hello")
  await page.getByRole("button", { name: "Write a standup" }).click()
  await settled(page)
  await page.keyboard.type("today")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#sent")).toBe("hello /standup today")
  await page.close()
})

const editorChunk = (url: URL) => url.pathname.endsWith("/@ui-sdk_web_token-input.js")

async function openHeld(): Promise<{ page: Page; release: () => void }> {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const page = await harness.open("composer", {
    before: (page) =>
      page.route(editorChunk, async (route) => {
        await held
        await route.continue()
      }),
  })
  return { page, release }
}

const upgraded = (page: Page) => page.waitForFunction(() => customElements.get("ui-token-input-editor") !== undefined && document.querySelector("textarea") === null)
const sends = async (page: Page): Promise<readonly string[]> => JSON.parse((await page.textContent("#sends")) ?? "[]")

test("an editor chunk that fails shows the error and Try again, and Try again gives a focused, working textbox", async () => {
  let fail = true
  const page = await harness.open("composer", {
    expected: /Failed to load resource/,
    before: (page) => page.route(editorChunk, (route) => (fail ? route.abort() : route.continue())),
  })
  try {
    const stopped = page.getByRole("alert")
    await stopped.waitFor()
    expect(await stopped.innerText()).toContain("The message box didn't load")
    expect(await editor(page).count()).toBe(0)
    fail = false
    await stopped.getByRole("button", { name: "Try again" }).click()
    await upgraded(page)
    expect(await page.getByRole("alert").count()).toBe(0)
    await settled(page)
    expect(await focused(page)).toBe("Message Ingle")
    await page.keyboard.type("back again")
    await page.keyboard.press("Enter")
    await settled(page)
    expect(await page.textContent("#sent")).toBe("back again")
  } finally {
    await page.close()
  }
})

test("before the editor chunk lands, the placeholder shows, and the text and selection carry into the editor", async () => {
  const { page, release } = await openHeld()
  try {
    const early = editor(page)
    expect(await early.evaluate((element) => element.tagName)).toBe("TEXTAREA")
    expect(await early.getAttribute("placeholder")).toBe("Ask anything, / for commands, @ for context")
    await early.click()
    await page.keyboard.type("hello world")
    await page.keyboard.press("Home")
    for (let step = 0; step < 2; step += 1) await page.keyboard.press("ArrowRight")
    for (let step = 0; step < 2; step += 1) await page.keyboard.press("Shift+ArrowRight")
    release()
    await upgraded(page)
    await settled(page)
    await page.keyboard.type("X")
    expect(await editor(page).innerText()).toBe("heXo world")
    await page.keyboard.press("Enter")
    await settled(page)
    expect(await sends(page)).toEqual(["heXo world+0"])
  } finally {
    release()
    await page.close()
  }
})

test("a backwards selection made before the upgrade keeps its direction", async () => {
  const { page, release } = await openHeld()
  try {
    await editor(page).click()
    await page.keyboard.type("hello world")
    await page.keyboard.press("Home")
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowRight")
    for (let step = 0; step < 2; step += 1) await page.keyboard.press("Shift+ArrowLeft")
    release()
    await upgraded(page)
    await settled(page)
    await page.keyboard.press("Shift+ArrowLeft")
    await page.keyboard.type("X")
    expect(await editor(page).innerText()).toBe("hXo world")
  } finally {
    release()
    await page.close()
  }
})

test("the first undo after the upgrade keeps the draft typed before it", async () => {
  const { page, release } = await openHeld()
  try {
    await editor(page).click()
    await page.keyboard.type("draft text")
    release()
    await upgraded(page)
    await settled(page)
    await page.keyboard.press("ControlOrMeta+Z")
    await settled(page)
    expect(await editor(page).innerText()).toBe("draft text")
    expect(await page.getByRole("button", { name: "Send message" }).isEnabled()).toBe(true)
  } finally {
    release()
    await page.close()
  }
})

test("an input method composing when the editor chunk lands finishes in the textarea and carries over committed", async () => {
  const { page, release } = await openHeld()
  const cdp = await page.context().newCDPSession(page)
  try {
    await editor(page).click()
    await page.keyboard.type("abc ")
    await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 })
    release()
    await page.waitForFunction(() => customElements.get("ui-token-input-editor") !== undefined)
    await settled(page)
    expect(await page.locator("textarea").count()).toBe(1)
    await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 })
    await cdp.send("Input.insertText", { text: "日本" })
    await upgraded(page)
    await settled(page)
    expect(await editor(page).innerText()).toBe("abc 日本")
    await page.keyboard.press("Enter")
    await settled(page)
    expect(await sends(page)).toEqual(["abc 日本+0"])
  } finally {
    release()
    await cdp.detach()
    await page.close()
  }
})

test("before the editor chunk lands, Send sends an attachment and Enter sends the draft, each once", async () => {
  const { page, release } = await openHeld()
  try {
    await page.locator("input[type=file].hidden").setInputFiles({ name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from("# plan") })
    await page.getByRole("button", { name: "Send message" }).click()
    await settled(page)
    expect(await sends(page)).toEqual(["+1"])
    await editor(page).click()
    await page.keyboard.type("early send")
    await page.keyboard.press("Enter")
    await settled(page)
    expect(await sends(page)).toEqual(["+1", "early send+0"])
    expect(await editor(page).inputValue()).toBe("")
    release()
    await upgraded(page)
    await settled(page)
    expect(await editor(page).innerText()).toBe("")
    expect(await sends(page)).toEqual(["+1", "early send+0"])
  } finally {
    release()
    await page.close()
  }
})

test("Command registers with the composer at startup, so the + menu loads only Menu on intent", async () => {
  const requested: string[] = []
  const page = await harness.open("composer", { before: async (page) => page.on("request", (request) => requested.push(new URL(request.url()).pathname)) })
  try {
    expect(await page.evaluate(() => customElements.get("ui-command") !== undefined)).toBe(true)
    const before = requested.length
    await page.getByRole("button", { name: "Add" }).hover()
    await page.waitForFunction(() => customElements.get("ui-menu") !== undefined)
    expect(requested.slice(before).filter((path) => path.includes("ui-sdk_web_command"))).toEqual([])
  } finally {
    await page.close()
  }
})
