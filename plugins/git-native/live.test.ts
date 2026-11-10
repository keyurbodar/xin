import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { liveEnabled } from "../../test/live.ts"
import { fresh, setRow } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { cloneInto, diff, log, open, repoId, show } from "./git.ts"

const URL = "https://gitlab.com/gitlab-org/gitlab-runner.git"

describe.skipIf(!liveEnabled())("native git against another host", () => {
  it("clones a GitLab repository and reads its history, a file and a diff", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git-native", true)
    let calls = 0
    const result = await runInDurableObject(stub, async (home: Home) => {
      const port = {
        db: home.db,
        bucket: env.FILES,
        fetcher: (input: string, init?: RequestInit) => {
          calls += 1
          return fetch(input, init)
        },
        now: () => Date.now(),
      }
      const cloned = await cloneInto(port, { project: "live-git", url: URL, depth: 5 })
      const id = await repoId("live-git", URL)
      const reader = await open(port, id)
      if (reader === undefined) throw new Error("the clone was not stored")
      const afterClone = calls
      const entries = await log(reader, { limit: 3 })
      const again = await log(reader, { limit: 3 })
      const parent = entries.commits[1]
      if (parent === undefined) throw new Error("the clone carried no history")
      const files = await diff(reader, { base: `${parent.sha}~1`, head: parent.sha })
      const shown = await show(port, reader, { path: "README.md" })
      return {
        cloned: cloned.row,
        fetches: cloned.fetches,
        afterClone,
        reads: calls - afterClone,
        commits: entries.commits.map((commit) => commit.subject),
        same: again.commits.map((commit) => commit.sha).join() === entries.commits.map((commit) => commit.sha).join(),
        files: files.map((file) => file.path),
        patches: files.filter((file) => file.patch !== null).length,
        readme: shown.text.slice(0, 40),
      }
    })
    expect(result.cloned.branch).toBe("main")
    expect(result.cloned.partial).toBe(0)
    expect(result.commits).toHaveLength(3)
    expect(result.same).toBe(true)
    expect(result.reads).toBe(0)
    expect(result.files.length).toBeGreaterThan(0)
    expect(result.patches).toBeGreaterThan(0)
    expect(result.readme.length).toBeGreaterThan(0)
    console.warn(
      `live git: ${result.cloned.objects} objects, ${(result.cloned.pack_bytes / 1024).toFixed(0)} KB, ${result.fetches} requests to clone, ${result.reads} for three reads`,
    )
  }, 180_000)
})
