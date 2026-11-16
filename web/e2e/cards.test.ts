import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"

const web = fileURLToPath(new URL("..", import.meta.url))
const renders = process.env.INGLE_RENDERS_DIR
const SECRET = "ghp_e2e-never-shown-4c1d"
const TOOLS = ["ask_user", "request_approval", "request_connection", "request_secret"] as const
const ANSWERS: Record<(typeof TOOLS)[number], string> = {
  ask_user: "eu-west",
  request_approval: "Approve",
  request_connection: "connected",
  request_secret: "stored as GITHUB_TOKEN",
}
const POLICY_OPTIONS = ["Approve", "Always allow", "Deny"]
const ASKED_OPTIONS = ["Approve", "Deny"]
const LONG_ARGUMENTS = JSON.stringify({ url: "https://example.com/pricing", note: "😀".repeat(600) })

let browser: Browser | undefined
let server: ViteDevServer | undefined
let base = ""

beforeAll(async () => {
  server = await createServer({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "error",
    server: { port: 0, host: "127.0.0.1" },
  })
  await server.listen()
  base = server.resolvedUrls?.local[0] ?? ""
  browser = await chromium.launch()
  if (renders !== undefined) mkdirSync(renders, { recursive: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

type Frame = { readonly id: string; readonly op: string; readonly args: Record<string, unknown> }
type Home = { readonly page: Page; readonly sent: Frame[]; readonly bodies: string[] }

/** A page whose `/v1/cmd` is a small stand-in Home: one open, one answered and one declined request per card. */
async function open(theme: "dark" | "light"): Promise<Home> {
  if (browser === undefined) throw new Error("no browser")
  const page = await browser.newPage({ viewport: { width: 900, height: 2400 } })
  const sent: Frame[] = []
  const bodies: string[] = []
  const pending = new Set([...TOOLS.map((tool) => `${tool}-open`), "approval:open"])
  const answered = new Map<string, string>([
    ...TOOLS.flatMap((tool): [string, string][] => [
      [`${tool}-answered`, ANSWERS[tool]],
      [`${tool}-declined`, tool === "request_approval" ? "Deny" : "declined"],
    ]),
    ["approval:answered", "Always allow"],
    ["approval:declined", "Deny"],
  ])
  const kindOf = (id: string): string =>
    id.startsWith("approval:") || id.startsWith("request_approval-") ? "approval" : id.slice(0, id.lastIndexOf("-"))
  const subjectOf = (id: string): Record<string, unknown> => {
    if (id.startsWith("approval:")) return { options: POLICY_OPTIONS, subject: { tool: "web_fetch", arguments: LONG_ARGUMENTS } }
    if (id.startsWith("request_approval-"))
      return { options: ASKED_OPTIONS, subject: { tool: "Delete the staging bucket", arguments: "It holds 1,204 objects." } }
    return {}
  }
  const result = (frame: Frame): unknown => {
    switch (frame.op) {
      case "request.list":
        return {
          requests: [
            {
              id: "approval:root-call",
              kind: "approval",
              conversationId: 1,
              question: "Fetch the status page",
              options: POLICY_OPTIONS,
              subject: { tool: "web_fetch", arguments: '{"url":"https://example.com/status"}' },
              askedAt: 1,
            },
            ...[...pending].map((id) => ({
            id,
            kind: kindOf(id),
            conversationId: 7,
            projectId: "prj_1",
            projectName: "Demo",
            threadTitle: "Cards",
            question: id.startsWith("approval:") ? "Fetch the pricing page" : "q",
            ...subjectOf(id),
            askedAt: 1,
            })),
          ],
          answered: [...answered].map(([id, answer]) => ({ id, kind: kindOf(id), conversationId: 7, answer, answeredAt: 2 })),
        }
      case "request.respond":
      case "secret.provide": {
        const id = String(frame.args.requestId)
        pending.delete(id)
        const answer =
          frame.op === "request.respond" ? String(frame.args.answer) : frame.args.value === undefined ? "declined" : "stored as GITHUB_TOKEN"
        answered.set(id, answer)
        return { kind: "answered", run: 2 }
      }
      default:
        return {}
    }
  }
  await page.route("**/v1/cmd", async (route) => {
    const body = route.request().postData() ?? "null"
    bodies.push(body)
    const parsed: unknown = JSON.parse(body)
    const frames = (Array.isArray(parsed) ? parsed : [parsed]) as Frame[]
    sent.push(...frames)
    const acks = frames.map((frame) => ({ id: frame.id, ok: true, result: result(frame) }))
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(Array.isArray(parsed) ? acks : acks[0]) })
  })
  await page.goto(`${base}e2e/fixtures/cards.html?theme=${theme}`)
  await page.waitForSelector('[data-tool="request_secret"] [data-state="declined"] [data-card="declined"]')
  await page.waitForSelector('[data-tool="approval"] [data-state="open"] [data-card="open"]')
  return { page, sent, bodies }
}

const card = (page: Page, tool: string, state: string) => page.locator(`[data-tool="${tool}"] [data-state="${state}"] section`)

for (const theme of ["dark", "light"] as const) {
  test(`every card shows its open, answered and declined state in ${theme}`, async () => {
    const { page } = await open(theme)
    try {
      for (const tool of TOOLS) {
        expect(await card(page, tool, "open").getAttribute("data-card")).toBe("open")
        expect(await card(page, tool, "answered").getAttribute("data-card")).toBe("answered")
        expect(await card(page, tool, "declined").getAttribute("data-card")).toBe("declined")
        for (const closed of ["answered", "declined"])
          expect(await card(page, tool, closed).locator("button, input").count()).toBe(0)
        expect(await card(page, tool, "declined").innerText()).toContain("Declined")
      }
      expect(await card(page, "request_secret", "answered").innerText()).toContain("Stored as GITHUB_TOKEN")
      expect(await card(page, "ask_user", "answered").innerText()).toContain("eu-west")
      expect(await card(page, "request_approval", "answered").innerText()).toContain("Approve")
      expect(await card(page, "request_connection", "answered").innerText()).toContain("Linear connected")
      expect(await card(page, "request_secret", "open").locator('input[type="password"]').count()).toBe(1)
      const background = await card(page, "request_approval", "open").evaluate((node) => getComputedStyle(node).backgroundColor)
      expect(background).not.toBe("rgba(0, 0, 0, 0)")
      if (renders !== undefined) await page.screenshot({ path: join(renders, `cards-${theme}.png`), fullPage: true })
    } finally {
      await page.close()
    }
  }, 60_000)
}

test("approval answers from the keyboard and locks once decided", async () => {
  const { page, sent } = await open("dark")
  try {
    const approval = card(page, "request_approval", "open")
    expect(await approval.getByRole("group", { name: "Decision" }).getByRole("button").allInnerTexts()).toEqual(ASKED_OPTIONS)
    expect(await approval.locator("[data-call]").count(), "an agent ask shows its action as prose").toBe(0)
    await approval.getByRole("button", { name: "Approve" }).focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      () => document.querySelector('[data-tool="request_approval"] [data-state="open"] section')?.getAttribute("data-card") === "answered",
    )
    expect(sent.find((frame) => frame.op === "request.respond")?.args).toEqual({
      threadId: 7,
      requestId: "request_approval-open",
      answer: "Approve",
    })
    expect(await approval.locator("button").count()).toBe(0)
  } finally {
    await page.close()
  }
}, 60_000)

test("ask_user answers with an option or free text through request.respond", async () => {
  const { page, sent } = await open("dark")
  try {
    const ask = card(page, "ask_user", "open")
    await ask.getByRole("textbox", { name: "Your answer" }).fill("somewhere cheap")
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      () => document.querySelector('[data-tool="ask_user"] [data-state="open"] section')?.getAttribute("data-card") === "answered",
    )
    expect(sent.find((frame) => frame.op === "request.respond")?.args.answer).toBe("somewhere cheap")
    expect(await ask.innerText()).toContain("somewhere cheap")
  } finally {
    await page.close()
  }
}, 60_000)

test("connect opens the connectors page and reports connected", async () => {
  const { page, sent } = await open("dark")
  try {
    const connect = card(page, "request_connection", "open")
    await connect.getByRole("button", { name: "Open connectors" }).click()
    expect(await page.evaluate(() => location.hash)).toBe("#/extensions/customize")
    await connect.getByRole("button", { name: "It's connected" }).click()
    await page.waitForFunction(
      () => document.querySelector('[data-tool="request_connection"] [data-state="open"] section')?.getAttribute("data-card") === "answered",
    )
    expect(sent.find((frame) => frame.op === "request.respond")?.args.answer).toBe("connected")
  } finally {
    await page.close()
  }
}, 60_000)

test("the secret card sends its value only to secret.provide and never shows it again", async () => {
  const { page, sent, bodies } = await open("dark")
  try {
    const secret = card(page, "request_secret", "open")
    await secret.getByLabel("Value for GITHUB_TOKEN").fill(SECRET)
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      () => document.querySelector('[data-tool="request_secret"] [data-state="open"] section')?.getAttribute("data-card") === "answered",
    )
    const provided = sent.filter((frame) => frame.op === "secret.provide")
    expect(provided.map((frame) => frame.args)).toEqual([{ threadId: 7, requestId: "request_secret-open", value: SECRET }])
    expect(bodies.filter((body) => body.includes(SECRET))).toHaveLength(1)
    expect(sent.filter((frame) => frame.op !== "secret.provide" && JSON.stringify(frame).includes(SECRET))).toEqual([])
    expect(await secret.innerText()).toContain("Stored as GITHUB_TOKEN")
    const shown = await page.evaluate(
      () => document.body.innerHTML + [...document.querySelectorAll("input")].map((input) => input.value).join(""),
    )
    expect(shown).not.toContain(SECRET)
  } finally {
    await page.close()
  }
}, 60_000)

test("declining a secret card stores nothing", async () => {
  const { page, sent } = await open("light")
  try {
    await card(page, "request_secret", "open").getByRole("button", { name: "Decline" }).click()
    await page.waitForFunction(
      () => document.querySelector('[data-tool="request_secret"] [data-state="open"] section')?.getAttribute("data-card") === "declined",
    )
    expect(sent.find((frame) => frame.op === "secret.provide")?.args).toEqual({ threadId: 7, requestId: "request_secret-open" })
  } finally {
    await page.close()
  }
}, 60_000)

for (const theme of ["dark", "light"] as const) {
  test(`a policy approval shows the held-back call and its open, answered and denied states in ${theme}`, async () => {
    const { page } = await open(theme)
    try {
      const opened = card(page, "approval", "open")
      expect(await opened.count(), "the agent's own ask is left to its tool block").toBe(1)
      expect(await opened.getAttribute("data-card")).toBe("open")
      expect(await opened.getByRole("group", { name: "Decision" }).getByRole("button").allInnerTexts()).toEqual(POLICY_OPTIONS)
      const preview = opened.locator("[data-call=web_fetch] pre")
      const shown = await preview.innerText()
      const points = Array.from(shown)
      expect(points).toHaveLength(500)
      expect(points.at(-1)).toBe("…")
      expect(LONG_ARGUMENTS.startsWith(points.slice(0, -1).join(""))).toBe(true)
      const style = await preview.evaluate((node) => {
        const computed = getComputedStyle(node)
        return { font: computed.fontFamily, wrap: computed.whiteSpace }
      })
      expect(style.font).toMatch(/mono/i)
      expect(style.wrap).toBe("pre-wrap")
      expect(await opened.locator("[data-call=web_fetch]").innerText()).toContain("web_fetch")
      const root = card(page, "approval", "root")
      expect(await root.getAttribute("data-card"), "a root-chat row with no project renders").toBe("open")
      expect(await root.innerText()).toContain("Fetch the status page")

      const answered = card(page, "approval", "answered")
      expect(await answered.getAttribute("data-card")).toBe("answered")
      expect(await answered.innerText()).toContain("Always allow")
      const denied = card(page, "approval", "declined")
      expect(await denied.getAttribute("data-card")).toBe("declined")
      for (const closed of [answered, denied]) expect(await closed.locator("button").count()).toBe(0)
      if (renders !== undefined) await page.screenshot({ path: join(renders, `approval-${theme}.png`), fullPage: true })
    } finally {
      await page.close()
    }
  }, 60_000)
}

test("a policy approval answers Always allow from the keyboard with the option string", async () => {
  const { page, sent } = await open("light")
  try {
    const approval = card(page, "approval", "open")
    await approval.getByRole("button", { name: "Approve" }).focus()
    await page.keyboard.press("Tab")
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Always allow")
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      () => document.querySelector('[data-tool="approval"] [data-state="open"] section')?.getAttribute("data-card") === "answered",
    )
    expect(sent.find((frame) => frame.op === "request.respond")?.args).toEqual({
      threadId: 7,
      requestId: "approval:open",
      answer: "Always allow",
    })
    expect(await approval.innerText()).toContain("Always allow")
    expect(await approval.locator("button").count()).toBe(0)
  } finally {
    await page.close()
  }
}, 60_000)
