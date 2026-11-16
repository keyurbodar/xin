import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"

export type Harness = {
  readonly open: (fixture: string, query?: string) => Promise<Page>
  readonly close: () => Promise<void>
}

export async function startHarness(): Promise<Harness> {
  const root = new URL("..", import.meta.url).pathname
  const server: ViteDevServer = await createServer({
    root,
    configFile: `${root}vite.config.ts`,
    server: { port: 0, strictPort: false, hmr: false, fs: { strict: false } },
    logLevel: "error",
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (address === null || address === undefined || typeof address === "string") throw new Error("vite did not bind a port")
  const browser: Browser = await chromium.launch()
  return {
    open: async (fixture, query = "") => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(String(error)))
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text())
      })
      await page.goto(`http://127.0.0.1:${address.port}/e2e/fixtures/${fixture}.html${query}`)
      await page.waitForFunction(() => document.body.dataset.ready === "1", undefined, { timeout: 60_000 })
      if (errors.length > 0) throw new Error(errors.join("\n"))
      return page
    },
    close: async () => {
      await browser.close()
      await server.close()
    },
  }
}
