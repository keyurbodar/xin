import { nodeSha1 } from "./pack.ts"
import {
  cloneInto,
  diffIso,
  diffNative,
  logIso,
  logNative,
  type Mode,
  nativeClone,
  open,
  showIso,
  showNative,
} from "./repo.ts"
import { CountingStore, MemoryStore } from "./store.ts"

const args = new Map(process.argv.slice(2).map((arg) => arg.split("=") as [string, string]))
const repo = args.get("repo") ?? "octocat/Hello-World"
const mode = (args.get("mode") ?? "pack") as Mode
const depth = args.get("depth") === undefined || args.get("depth") === "full" ? undefined : Number(args.get("depth"))
const impl = args.get("impl") ?? "native"
const paths = (args.get("paths") ?? "README.md,package.json,Readme.md,index.js").split(",")
const url = `https://github.com/${repo}.git`
const prefix = `n/${repo}/${mode}/${depth ?? "full"}`

const cpu = (): number => {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}
const mb = (bytes: number): string => (bytes / 1048576).toFixed(1)

let peak = 0
const sampler = setInterval(() => {
  const used = process.memoryUsage()
  peak = Math.max(peak, used.heapUsed + used.external)
}, 10)
sampler.unref()

const rows: string[] = []
const report = (name: string, detail: Record<string, unknown>): void => {
  rows.push(JSON.stringify({ repo, depth: depth ?? "full", impl, op: name, ...detail }))
}

async function measure<T>(
  name: string,
  run: () => Promise<T>,
  detail: (value: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const before = cpu()
  const started = performance.now()
  const value = await run()
  report(name, { ms: Math.round(performance.now() - started), cpuMs: Math.round(cpu() - before), ...detail(value) })
  return value
}

const store = new CountingStore(new MemoryStore())
const counters = store.counters

await measure(
  "clone",
  async () =>
    impl === "native"
      ? nativeClone(store, prefix, { url, sha1: nodeSha1, ...(depth === undefined ? {} : { depth }) })
      : cloneInto(store, prefix, { url, mode, ...(depth === undefined ? {} : { depth }) }),
  (outcome) => ({
    objects: outcome.meta.objects,
    packKB: Math.round(outcome.meta.packBytes / 1024),
    fetches: outcome.fetches,
    fetchKB: Math.round(outcome.fetchBytes / 1024),
    writes: counters.writes,
    phases: outcome.phases.map((phase) => `${phase.name}:${Math.round(phase.ms)}ms`).join(" | "),
    ...(impl === "native" && "retained" in outcome ? { retainedMB: mb(Number(outcome.retained)) } : {}),
  }),
)

const opened = await measure(
  "open",
  async () => open(store, prefix),
  () => ({ reads: counters.reads, bytes: counters.bytesRead }),
)
const head = opened.meta.head
const pack = opened.pack
if (pack === undefined) throw new Error("no pack in this store")

const commits = await measure(
  "log-native",
  async () => logNative(pack, head, 20),
  (value) => ({ commits: value.length, first: value[0]?.subject.slice(0, 50) }),
)
await measure(
  "log-iso",
  async () => logIso(opened, 20),
  (value) => ({ commits: value.length }),
)
await measure(
  "log-native-warm",
  async () => logNative(pack, head, 20),
  (value) => ({ commits: value.length }),
)

if (commits.length > 1) {
  const base = commits[1]?.sha ?? ""
  const top = commits[0]?.sha ?? head
  await measure(
    "diff-native",
    async () => diffNative(pack, base, top),
    (value) => ({ files: value.length, lines: value.reduce((sum, file) => sum + file.patch.split("\n").length, 0) }),
  )
  await measure(
    "diff-iso",
    async () => diffIso(opened, base, top),
    (value) => ({ files: value.length }),
  )
}

for (const path of paths) {
  try {
    await measure(
      `show-native`,
      async () => showNative(pack, head, path),
      (value) => ({ path, bytes: value.bytes }),
    )
    await measure(
      `show-iso`,
      async () => showIso(opened, head, path),
      (value) => ({ path, bytes: value.bytes }),
    )
    break
  } catch {
    continue
  }
}

clearInterval(sampler)
const out = (line: string): void => void process.stdout.write(`${line}\n`)
for (const row of rows) out(row)
out(
  JSON.stringify({
    repo,
    depth: depth ?? "full",
    impl,
    op: "totals",
    peakMB: mb(peak),
    reads: counters.reads,
    readKB: Math.round(counters.bytesRead / 1024),
    writes: counters.writes,
    writtenKB: Math.round(counters.bytesWritten / 1024),
  }),
)
