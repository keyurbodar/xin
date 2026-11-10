import { subtleSha1 } from "./pack.ts"
import {
  cloneInto,
  diffIso,
  diffNative,
  logIso,
  logNative,
  type Mode,
  nativeClone,
  type Opened,
  open,
  showIso,
  showNative,
  time,
} from "./repo.ts"
import { CountingStore, R2Store } from "./store.ts"

type Env = { readonly FILES: R2Bucket }

const CACHE = new Map<string, Opened>()
const CACHE_LIMIT = 4
const PATHS = "package.json,README.md,README,Readme.md,index.js"

const prefixOf = (repo: string, mode: Mode, depth: number | undefined): string =>
  `gitnative/${repo}/${mode}/${depth ?? "full"}`

async function opened(counter: CountingStore, prefix: string): Promise<{ opened: Opened; cached: boolean }> {
  const hit = CACHE.get(prefix)
  if (hit !== undefined) return { opened: hit, cached: true }
  const fresh = await open(counter, prefix)
  if (CACHE.size >= CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value ?? "")
  CACHE.set(prefix, fresh)
  return { opened: fresh, cached: false }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value, null, 1), { status, headers: { "content-type": "application/json" } })

const num = (url: URL, name: string): number | undefined => {
  const raw = url.searchParams.get(name)
  return raw === null ? undefined : Number(raw)
}

const round = (value: number): number => Math.round(value)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const repo = url.searchParams.get("repo") ?? "octocat/Hello-World"
    const mode = (url.searchParams.get("mode") ?? "pack") as Mode
    const depth = num(url, "depth")
    const prefix = prefixOf(repo, mode, depth)
    const counter = new CountingStore(new R2Store(env.FILES))
    try {
      if (url.pathname === "/reset") {
        for (const key of await counter.list(prefix)) await env.FILES.delete(key)
        CACHE.delete(prefix)
        return json({ cleared: prefix })
      }
      if (url.pathname === "/native") {
        const outcome = await nativeClone(counter, prefix, {
          url: `https://github.com/${repo}.git`,
          sha1: subtleSha1,
          ...(depth === undefined ? {} : { depth }),
        })
        return json({ ...outcome, store: counter.counters })
      }
      if (url.pathname === "/clone") {
        const outcome = await cloneInto(counter, prefix, {
          url: `https://github.com/${repo}.git`,
          mode,
          ...(depth === undefined ? {} : { depth }),
        })
        return json({ ...outcome, store: counter.counters })
      }
      if (url.pathname === "/bench") {
        const budget = num(url, "budget")
        if (url.searchParams.get("reuse") === null)
          for (const key of await counter.list(prefix)) await env.FILES.delete(key)
        CACHE.delete(prefix)
        const clone = await time(counter, async () =>
          nativeClone(counter, prefix, {
            url: `https://github.com/${repo}.git`,
            sha1: subtleSha1,
            ...(depth === undefined ? {} : { depth }),
            ...(budget === undefined ? {} : { budget: budget * 1048576 }),
          }),
        )
        const cold = await time(counter, async () => {
          const repository = await open(counter, prefix)
          CACHE.set(prefix, repository)
          return repository
        })
        const repository = CACHE.get(prefix)
        if (repository?.pack === undefined) return json({ error: "no pack" }, 500)
        const head = repository.meta.head
        const log = await time(counter, async () => logNative(repository.pack!, head, 20))
        const warm = await time(counter, async () => logNative(repository.pack!, head, 20))
        let show: { path: string; bytes: number; ms: number } | undefined
        for (const path of (url.searchParams.get("paths") ?? PATHS).split(",")) {
          try {
            const shown = await time(counter, async () => showNative(repository.pack!, head, path))
            show = { path, bytes: shown.value.bytes, ms: round(shown.ms) }
            break
          } catch {
            continue
          }
        }
        const base = log.value[1]?.sha
        const diff =
          base === undefined
            ? undefined
            : await time(counter, async () => diffNative(repository.pack!, base, log.value[0]?.sha ?? head))
        return json({
          repo,
          depth: depth ?? "full",
          clone: {
            ms: round(clone.ms),
            phases: clone.value.phases.map((phase) => `${phase.name}:${round(phase.ms)}ms`),
            objects: clone.value.meta.objects,
            packKB: round(clone.value.meta.packBytes / 1024),
            fetches: clone.value.fetches,
            fetchKB: round(clone.value.fetchBytes / 1024),
            retainedMB: round((clone.value.retained / 1048576) * 10) / 10,
            writes: clone.writes,
          },
          coldOpen: { ms: round(cold.ms), reads: cold.reads, readKB: round(cold.bytesRead / 1024) },
          log: { ms: round(log.ms), commits: log.value.length, reads: log.reads, bytesRead: log.bytesRead },
          logWarm: { ms: round(warm.ms), reads: warm.reads },
          show,
          diff:
            diff === undefined
              ? undefined
              : {
                  ms: round(diff.ms),
                  files: diff.value.length,
                  lines: diff.value.reduce((sum, file) => sum + file.patch.split("\n").length, 0),
                },
          total: counter.counters,
        })
      }
      const { opened: repository, cached } = await opened(counter, prefix)
      const head = repository.meta.head
      if (url.pathname === "/log") {
        const limit = num(url, "limit") ?? 20
        const native = await time(counter, async () => logNative(repository.pack!, head, limit))
        const iso = await time(counter, async () => logIso(repository, limit))
        return json({ prefix, cached, head, native, iso })
      }
      if (url.pathname === "/show") {
        const path = url.searchParams.get("path") ?? "README.md"
        const rev = url.searchParams.get("rev") ?? head
        const native = await time(counter, async () => showNative(repository.pack!, rev, path))
        const iso = await time(counter, async () => showIso(repository, rev, path))
        return json({ prefix, cached, native, iso })
      }
      if (url.pathname === "/diff") {
        const base = url.searchParams.get("base")
        const next = url.searchParams.get("head") ?? head
        if (base === null) return json({ error: "base is required" }, 400)
        const native = await time(counter, async () => diffNative(repository.pack!, base, next))
        const iso = await time(counter, async () => diffIso(repository, base, next))
        return json({ prefix, cached, native, iso })
      }
      return json({ error: "unknown route" }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 500)
    }
  },
}
