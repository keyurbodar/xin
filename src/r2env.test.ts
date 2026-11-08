import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  type EnvConformanceAssertions,
  type EnvConformanceProvider,
  createEnvConformance,
} from "@earendil-works/pi-durable/testing"
import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { fresh } from "../test/support.ts"
import type { Home } from "../test/worker.ts"
import { FileIndex, R2Env } from "./r2env.ts"

const assertions: EnvConformanceAssertions = {
  ok: (value, message) => expect(value, message).toBeTruthy(),
  strictEqual: (actual, expected) => expect(actual).toStrictEqual(expected),
  deepEqual: (actual, expected) => expect(actual).toEqual(expected),
  partialDeepEqual: (actual, expected) =>
    expect(actual).toMatchObject(expected !== null && typeof expected === "object" ? expected : {}),
  greaterThan: (actual, expected) => expect(actual).toBeGreaterThan(expected),
  rejects: async (operation, messageIncludes) => {
    await expect(operation).rejects.toThrow(messageIncludes)
  },
}

const withCase = <T>(use: (files: R2Env, home: Home) => Promise<T>): Promise<T> =>
  runInDurableObject(fresh(), (home: Home) => use(new R2Env(env.FILES, home.db, { cwd: "/" }), home))

const withEnv = <T>(use: (files: R2Env) => Promise<T>): Promise<T> => withCase((files) => use(files))

const provider: EnvConformanceProvider = (use) => withEnv(use)

const unsupported = (name: string): string | undefined =>
  name.startsWith("watch")
    ? "R2 has no change notifications; watch is not supported"
    : name.includes("exec")
      ? "Xin runs files only, so exec returns shell_unavailable"
      : undefined

const cases = createEnvConformance({ assertions, withEnv: provider, symlinks: false })

describe("R2Env conformance", () => {
  for (const conformance of cases) {
    const skipped = unsupported(conformance.name)
    const timeout = conformance.timeoutMs ?? 20_000
    if (skipped !== undefined) it.skip(conformance.name, () => conformance.run(), timeout)
    else it(conformance.name, () => conformance.run(), timeout)
  }

  it("reports exec as unavailable rather than running code", async () => {
    const result = await withEnv((files) => files.exec(["sh", "-c", "true"], undefined, BACKGROUND_CONTEXT))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("shell_unavailable")
  })

  it("stores identical content at one content-addressed key", async () => {
    const keys = await withCase(async (files, home) => {
      expect((await files.writeFile("one.txt", "same bytes", BACKGROUND_CONTEXT)).ok).toBe(true)
      expect((await files.writeFile("two.txt", "same bytes", BACKGROUND_CONTEXT)).ok).toBe(true)
      const rows = await new FileIndex(home.db).under("/")
      return rows.map((row) => row.r2_key)
    })
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
  })
})
