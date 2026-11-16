import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { Machine } from "./backend.ts"
import { instaboxBackend } from "./instabox.ts"

const live = process.env.INSTABOX_LIVE === "1"

describe.skipIf(!live)("browser on a live Instabox machine", () => {
  it("creates a machine, opens example.com, reads a snapshot and deletes the machine", async () => {
    const backend = instaboxBackend({ apiKey: env.INSTABOX_API_KEY, vcpus: 2, memMiB: 4_096 })
    const signal = AbortSignal.timeout(300_000)
    let machine: Machine | undefined
    try {
      machine = await backend.start({ key: `ingle-browser-live:${crypto.randomUUID()}` }, signal)
      await backend.prepare(machine, signal)
      const opened = await backend.run(machine, ["agent-browser", "open", "https://example.com"], signal)
      expect(opened.exitCode, opened.stderr).toBe(0)
      expect(opened.stdout).toContain("Example Domain")
      const snapshot = await backend.run(machine, ["agent-browser", "snapshot", "-c"], signal)
      expect(snapshot.exitCode, snapshot.stderr).toBe(0)
      expect(snapshot.stdout).toMatch(/link "Learn more" \[ref=e\d+\]/)
    } finally {
      if (machine !== undefined) await backend.close(machine, AbortSignal.timeout(120_000))
    }
  }, 360_000)
})
