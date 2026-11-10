# Can a Worker run git itself? — prototype report

**Date:** 2026-11-10
**Branch:** `git/native-worker` (pushed; not for merge)
**Scope:** answer whether Xin can clone and read a git repository inside the Worker, with numbers, and what it would unlock.
**Prototype:** `test/git-native/` — a standalone Worker (`wrangler.jsonc`, R2 binding `FILES`) driven over HTTP, plus a Node harness for CPU and heap.

## Verdict

- **Yes, for small and medium repositories, if the pack reader is ours.** Cloning `chalk` (381 commits, 1.1 MB pack) takes **1.1 s** end to end inside the Worker and **132 ms** of it is indexing; `express` full history (6,186 commits, 9.7 MB, 32,576 objects) takes **3.5 s**, of which **1.6 s** is indexing. Reading after that is **0–7 ms** per `log`, `show` or `diff`, and **0 ms with 0 R2 reads** on a second read in the same isolate.
- **No, if the engine is isomorphic-git.** The same `express` clone takes **27.5 s** in the Worker (3.5 s with our reader), and its own `log`/`show`/`diff` are 10–40× slower than reading the pack directly. It works, but it is an order of magnitude over what a request should spend.
- **No, for large repositories, because of memory, not CPU.** A 72 MB pack clones and indexes fine; the 330 MB pack of `vercel/next.js` full history **crashed the workerd runtime** ("The Workers runtime crashed unexpectedly", twice) against the 128 MB isolate limit. Large repos need a partial clone (`filter=blob:none`) or are out.

The cheapest useful shape is: **one smart-HTTP fetch → build a git-format `.idx` with workerd's native zlib → store pack + idx in R2 (3 writes) → read objects straight out of the pack.** No git binary, no checkout, no dependency.

## What the prototype does

```text
GET /bench?repo=owner/name[&depth=N]
  clone   fetchPack()   protocol v2: GET info/refs, POST ls-refs, POST fetch   (3 subrequests)
          buildIndex()  one sequential scan + one native inflate per object, sha1 via crypto.subtle
          R2 put        pack.pack, pack.idx, meta.json                            (3 Class A ops)
  read    open()        R2 get meta.json, pack.pack, pack.idx                      (3 Class B ops)
          log           walk commits, all parents, committer-date order
          show          tree walk to a blob at a commit
          diff          two tree walks + an LCS line diff per changed file
```

| file | role |
| --- | --- |
| `test/git-native/smart.ts` | smart-HTTP v2 client: ref advertisement, `ls-refs`, `fetch`, pkt-line demux, shallow lines |
| `test/git-native/pack.ts` | pack reader: sequential header scan, `node:zlib` inflate, OFS/REF delta resolution, git v2 `.idx` writer |
| `test/git-native/repo.ts` | clone into a store, open, `log`, `show`, `diff`; the isomorphic-git equivalents used for comparison |
| `test/git-native/store.ts` | R2 and in-memory stores with read/write/byte counters |
| `test/git-native/fs.ts` | the in-memory `fs` isomorphic-git needs |
| `test/git-native/worker.ts` | the prototype Worker and its routes |
| `test/git-native/bench-node.ts` | Node harness: CPU time and heap for the same code paths |

Everything below was measured through `wrangler dev` (real workerd, real R2 binding) unless it says Node.

## Clone cost

Worker, one request per row, real R2, protocol v2, `depth` as shown. Times in ms.

| repository | history | pack | objects | clone | refs + download | index | R2 write | first read after eviction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| octocat/Hello-World | 3 commits | 1 KB | 7 | 830 | 560 + 252 | 4 | 13 | 7 ms, 3 reads, 2 KB |
| chalk/chalk | 381 commits | 1.1 MB | 1,706 | 1,137 | 536 + 432 | 132 | 37 | 13 ms, 3 reads, 1.1 MB |
| expressjs/express, depth 200 | 200 commits | 583 KB | 1,364 | 1,531 | 503 + 930 | 69 | 28 | 8 ms, 3 reads, 622 KB |
| expressjs/express | 6,186 commits | 9.7 MB | 32,576 | 3,532 | 714 + 1,009 | 1,634 | 175 | 76 ms, 3 reads, 10.6 MB |
| vercel/next.js, depth 1 | 1 commit | 47 MB | 44,494 | 8,561 | 559 + 4,510 | 2,629 | 863 | 129 ms, 3 reads, 48.7 MB |
| kubernetes/kubernetes, depth 1 | 1 commit | 47 MB | 30,345 | 13,273 | 703 + 9,086 | 2,607 | 877 | 123 ms, 3 reads |
| godotengine/godot, depth 1 | 1 commit | 72 MB | 15,220 | 23,170 | 625 + 18,744 | 2,618 | 1,183 | 114 ms, 3 reads, 72.8 MB |
| vercel/next.js | 44k commits | ~330 MB | — | **runtime crash** | — | — | — | — |

Two things stand out. The network dominates the wall clock (a cold 47 MB pack is 4.5–18.7 s of download), and the index is the only real CPU: **1.6 s for 32,576 objects, 2.6 s for 44,494** — about 50–60 µs per object, independent of repository size because it is per object, not per byte of history.

## Read cost

Worker, after the clone above, per request.

| repository | `log` 20 | `show` package.json | `diff` two commits | second `log` in the same isolate |
| --- | --- | --- | --- | --- |
| Hello-World | 1 ms | 0 ms | 0 ms | 0 ms, 0 reads |
| chalk | 1 ms | 1 ms (1,753 B) | 7 ms (10 files, 579 lines) | 0 ms, 0 reads |
| express depth 200 | 0 ms | 0 ms | 2 ms (1 file, 2 lines) | 1 ms, 0 reads |
| express full | 1 ms | 0 ms | 3 ms | 0 ms, 0 reads |
| next.js depth 1 | 0 ms | 1 ms (14,518 B) | — | 0 ms, 0 reads |

The isolate cache (whole pack per repository, 4 repositories) makes a repeat read free. After an eviction the first read pays the pack from R2: 76 ms for 10.6 MB, 114 ms for 72.8 MB — roughly 600 MB/s from R2 into workerd.

## isomorphic-git on the same Worker

| operation | ours | isomorphic-git |
| --- | --- | --- |
| `express` full clone, Worker | **3.5 s** | **27.5 s** |
| `express` full clone, Node | 5.0 s wall / 2.9 s CPU | 9.2 s wall / 8.7 s CPU |
| `log` 20 commits, `express` | 2 ms | 68 ms |
| `show` one file, `express` | 0 ms | 42 ms |
| `diff` two commits, `express` | 6 ms | 72 ms |
| `chalk` clone, Worker | 1.1 s | 1.1 s + **6.8 s** to write 1,706 loose objects |

isomorphic-git is correct and complete, and it runs — but its clone inflates and SHA-1s every object in JavaScript (pako + sha.js), which is the 27 s. It also needs an `fs` shim, a `Buffer`/`process` polyfill and about 1.5 MB of bundle.

## CPU and memory

Node, same modules, CPU from `process.cpuUsage` (the Worker does not report CPU; these are the same V8 code paths, so they are a proxy, not a measurement of workerd):

| repository | clone wall | clone CPU | index CPU | peak heap + external |
| --- | --- | --- | --- | --- |
| chalk full | 2.68 s | 0.43 s | 0.14 s | 26.6 MB |
| express full | 4.96 s | 2.95 s | 1.74 s | 40 MB |
| next.js depth 1 | 16.6 s | 5.04 s | 2.72 s | 71 MB |

Limits that matter:

- **CPU:** 30 s per request on Workers paid (this Worker already sets `limits.cpu_ms: 300000`, the 5-minute maximum). Every clone above is under 3 s of CPU. On the free plan (10 ms) none of this is possible.
- **Memory:** 128 MB per isolate. Measured working: a 72 MB pack plus 16 MB of retained delta bases. Measured failing: a 330 MB pack, which crashed the runtime rather than returning an error.
- **Subrequests:** 3 per clone, against 50 (free) or 1,000 (paid).
- **Retained delta bases** are the hidden cost: express full wants 68.7 MB unless the cache is capped. A 16 MB cap costs nothing in time (the bases are consumed in offset order), and is what the Worker rows above use.

## R2 operations and money

One clone = 3 Class A writes (pack, idx, meta). One read after an eviction = 3 Class B reads (meta, pack, idx). A repeat read = nothing. At R2 list prices (Class A $4.50/M, Class B $0.36/M, storage $0.015/GB-month):

| what | ops | cost |
| --- | --- | --- |
| one `express` clone | 3 Class A + 10.6 MB stored | $0.0000135 + $0.00016/month |
| 1,000 `express` clones | 3,000 Class A + 10.6 GB stored | $0.0135 + $0.16/month |
| 1,000 cold reads of `express` | 3,000 Class B, 10.6 GB read | $0.0011 |
| 1,000 warm reads | none | $0 |

Storage and operations are not the constraint. A repository that is cloned once and read a thousand times costs less than a cent a month. The constraint is the 128 MB isolate and the 30 s CPU budget.

## Correctness

Checked against git itself, not against itself:

- `express` `6389ae5..43fca52`: git says 1 file, +1/−1; the prototype's patch has exactly those two lines.
- `chalk` `HEAD~1..HEAD`: git says 10 files, 294 insertions, 285 deletions; the prototype reports 10 files and 579 patch lines (294 + 285).
- `chalk` `package.json` at `HEAD`: 1,753 bytes from both.
- Every one of `express`'s 32,576 objects, read back through our resolver, SHA-1s to the id in the index.

## What it unlocks that the GitHub API path cannot

1. **Any host.** GitLab, Gitea, Codeberg, a self-hosted server, any smart-HTTP remote. Today `git_log`/`git_show`/`git_diff`/`git_blame` are GitHub-only by construction.
2. **History the API will not serve.** `log --follow` across renames, blame computed locally, `commit:path` for any path, and diffs between any two commits — GitHub's compare endpoint caps at 250 files and 300 commits, and has no `--follow`.
3. **A working tree.** The files plugin already stores bytes in R2; with a pack reader, a file the agent edited can be diffed against a commit. There is no working tree in the API path at all.
4. **No token and no rate limit.** Public repositories read with three unauthenticated requests, then locally. The GitHub API allows 60 requests an hour unauthenticated, and `git_blame` already needs a named credential.
5. **A base for write.** Read-only was the prototype's limit, not the design's: adding a pack writer plus a `git-receive-pack` call is the missing function, not a new stack. Branch, commit and push become reachable from the same store.

## What a real implementation still needs

1. **Incremental fetch.** The prototype always clones from scratch; a refresh costs the full download again. Real code needs `have` lines or `deepen` against the stored refs.
2. **Range reads.** A cold read loads the whole pack (72 MB for godot). R2 `get(key, { range })` with the idx offsets would make a `log` cost a few KB.
3. **Refs and shallow state in SQLite** instead of a JSON object, and an object cache keyed by oid with a byte budget instead of a whole-pack LRU.
4. **A size policy.** Refuse packs over roughly 80 MB, or use `filter=blob:none` (protocol v2 supports it; untested here) so a 330 MB repository becomes ~120 MB of commits and trees with blobs fetched on demand.
5. **Auth, redirects and retries** for private repositories and for a rate-limited or flaky remote.
6. **Tests, a catalog row and a spec section** — `docs/plan/architecture/16-git.md` currently says "no clone" under *Not added*.

## Where the cost or the limits make it a bad idea

- **Large repositories.** 128 MB of isolate memory is the wall. `next.js` full history (330 MB) crashes the runtime; `linux`, `chromium` and `vscode` are worse. Depth-1 clones of big repositories (47–72 MB) work but cost 9–19 s of download for one commit of history.
- **isomorphic-git as the engine.** 27.5 s for a 10 MB repository in the Worker is not a request budget, it is a job. Use it as the reference for correctness, not as the implementation.
- **One R2 object per git object.** 1,706 writes took 6.8 s; a 32,000-object repository would take minutes and 32,000 Class A operations, for no benefit over two writes.
- **When the only question is "what does this GitHub repository's history say",** the existing API path is one request, ~300 ms, no storage and no cache to invalidate. Native git only pays off for many reads of one repository, for another host, or when a working tree is involved.

## Reproducing

```bash
cd test/git-native && bunx wrangler dev --config wrangler.jsonc --port 8801   # the prototype Worker, real R2
curl 'http://127.0.0.1:8801/bench?repo=expressjs/express'                      # clone + log + show + diff, one request
curl 'http://127.0.0.1:8801/clone?repo=chalk/chalk&mode=loose'                 # the per-object store, for comparison
node test/git-native/bench-node.ts repo=expressjs/express impl=native          # the same code in Node, with CPU and heap
```

`fmt`, `lint`, `types`, `bundle` and `test` all pass through the gate on this branch. Nothing in `src/` or `plugins/` changed: the prototype is `test/git-native/` plus this report, and the only dependency change is `isomorphic-git` (used as the comparison engine, not as the implementation).

## Two surprises worth recording

- **`node:zlib` in workerd:** `inflateSync(buf, { maxOutputLength: n })` throws `RangeError: Memory limit exceeded` for some `n` (65,536 and 98,304 both fail; 32,768 and 130,048 succeed) even though the output is a few hundred bytes. The same call without `maxOutputLength` works. The reader therefore inflates without the hint and checks the result length against the pack header instead. `inflateSync(buf, { info: true }).engine.bytesWritten` does work, and is how the sequential scan learns each object's compressed length.
- **GitHub's ref advertisement is bigger than the pack.** Protocol v0 sends every ref, including all `refs/pull/*`: 265 KB for `octocat/Hello-World` and ~1.1 MB for `chalk` against a 1.1 MB pack. Protocol v2 (`Git-Protocol: version=2`) with `ls-refs` and `ref-prefix refs/heads/` makes the advertisement 0.2 KB and the listing 23 KB.
