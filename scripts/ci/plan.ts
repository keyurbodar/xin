export type Job = {
  readonly name: string
  readonly script: string
  readonly files?: readonly string[]
}
export type Runner = { readonly jobs: readonly Job[] }

export const TEST_RUNNERS = 4
export const TEST_WORKERS = 6
export const RUNNERS_PER_RUN = TEST_RUNNERS + 1
export const VITEST_INCLUDE = `["src/**/*.test.ts", "plugins/**/*.test.ts", "test/**/*.test.ts"]`
const DEFAULT_MS = 2000

export const isVitestFile = (path: string) => /^(src|plugins|test)\//.test(path) && path.endsWith(".test.ts")

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export function shard(files: readonly string[], durations: ReadonlyMap<string, number>, count: number): string[][] {
  const bins = Array.from({ length: count }, () => ({ ms: 0, files: [] as string[] }))
  const weighed = files.map((file) => ({ file, ms: durations.get(file) ?? DEFAULT_MS })).toSorted((a, b) => b.ms - a.ms)
  for (const { file, ms } of weighed) {
    const lightest = bins.reduce((best, bin) => (bin.ms < best.ms ? bin : best))
    lightest.ms += ms
    lightest.files.push(file)
  }
  return bins.map((bin) => bin.files.toSorted())
}

export function plan(testFiles: readonly string[], durations: ReadonlyMap<string, number>): readonly Runner[] {
  const shards = shard(testFiles, durations, TEST_RUNNERS)
  const tests = shards.map((files, index): Runner => ({
    jobs: [
      {
        name: `test-${index + 1}`,
        files,
        script: `VITEST_MAX_WORKERS=${TEST_WORKERS} bun run test --reporter=default --reporter=json --outputFile=$HOME/vitest-${index + 1}.json ${files.map(quote).join(" ")}`,
      },
    ],
  }))
  const checks: Runner = {
    jobs: [
      { name: "fmt", script: "bun run fmt:check" },
      { name: "lint", script: "bun run lint" },
      { name: "types", script: "bunx tsgo --noEmit -p tsconfig.json" },
      { name: "bundle", script: "bun run bundle" },
      { name: "bench", script: "INGLE_LOAD=1 bun run test" },
      { name: "web-types", script: "cd web && bun run typecheck" },
      { name: "web-test", script: "cd web && bun run test src" },
      { name: "web-build", script: "cd web && bunx vite build" },
    ],
  }
  return [checks, ...tests]
}
