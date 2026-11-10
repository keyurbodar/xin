# Can a Worker run git itself? — prototype report

**Date:** 2026-11-10
**Branch:** `git/native-worker`, merged into `main` on 2026-11-10
**Scope:** answer whether Xin can clone and read a git repository inside the Worker, with numbers, and what it would unlock — then build it as the optional row `tool-git-native` (`plugins/git-native/`).
**Prototype:** `test/git-native/` — a standalone Worker (`wrangler.jsonc`, R2 binding `FILES`) driven over HTTP, plus a Node harness for CPU and heap. The prototype is the experiment; the row is the result, in [The row, as built](#the-row-as-built).

## Verdict

- **Yes, for small and medium repositories, if the pack reader is ours.** Cloning `chalk` (381 commits, 1.1 MB pack) takes **1.1 s** end to end inside the Worker and **132 ms** of it is indexing; `express` full history (6,186 commits, 9.7 MB, 32,576 objects) takes **3.5 s**, of which **1.6 s** is indexing. Reading after that is **0–7 ms** per `log`, `show` or `diff`, and **0 ms with 0 R2 reads** on a second read in the same isolate.
- **No, if the engine is isomorphic-git.** The same `express` clone takes **27.5 s** in the Worker (3.5 s with our reader), and its own `log`/`show`/`diff` are 10–40× slower than reading the pack directly. It works, but it is an order of magnitude over what a request should spend.
- **No, for large repositories, because of memory, not CPU.** A 72 MB pack clones and indexes fine; the 330 MB pack of `vercel/next.js` full history **crashed the workerd runtime** ("The Workers runtime crashed unexpectedly", twice) against the 128 MB isolate limit. Large repos need a partial clone (`filter=blob:none`) or are out.

The cheapest useful shape is: **one smart-HTTP fetch → build a git-format `.idx` with workerd's native zlib → store pack + idx in R2 (3 writes) → read objects straight out of the pack.** No git binary, no checkout, no dependency.

## The row, as built

`tool-git-native` is a native Cordis package in `plugins/git-native/`, one row in the `xin-plugin-git-native` bundle,
`disabled: true` like `tool-git`. It injects `pi`, `db` and `host`; it owns three tables (`git_native_repo`,
`git_native_ref`, `git_native_shallow`, applied by its own `git_native` migration) and three R2 objects per repository
(pack, v2 `.idx`, span table). The GitHub API row is untouched and stays the default path for GitHub.

```text
git_native_clone { url?, ref?, depth? }   clone or refresh a public remote of any host into R2
git_native_log   { url?, ref?, path?, limit? }
git_native_show  { url?, path, ref? }     one file at a revision
git_native_diff  { url?, base, head?, path? }
```

`url` defaults to the project's GitHub repository, so a GitHub project needs no new setting. Storage is keyed by project
slug and URL, so a thread reads only what its own project cloned. A read resolves refs and the shallow boundary from
SQLite, then reads objects out of the pack by R2 range: a pack up to 2 MB is kept whole in the isolate, a larger one is
read a few hundred bytes at a time.

Measured on 2026-11-10 with the row's own code, against real hosts, R2 replaced by an in-memory bucket with the same
range semantics (the same path runs in workerd in `plugins/git-native/live.test.ts`, which passes against GitLab):

| remote | depth | objects | pack | clone | requests | first read | second read, new reader | third read, same reader |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gitlab.com/gitlab-org/gitlab-runner | 5 | 2,420 | 4.5 MB | 4.9 s | 3 (4.6 MB) | 13 ms, 14 range reads, 92 KB | 4 ms, 12 reads, 5 KB | 0 ms, 0 reads |
| gitea.com/gitea/act | 5 | 1,222 | 3.2 MB | 6.7 s | 3 (3.2 MB) | 8 ms, 7 reads, 49 KB | 1 ms, 5 reads, 5 KB | 0 ms, 0 reads |
| gitlab.com/gitlab-org/gitlab-runner | 20 | 4,840 | 5.0 MB | 5.8 s | 3 (5.1 MB) | 21 ms, 12 reads, 176 KB | 3 ms, 10 reads, 5 KB | 0 ms, 0 reads |
| gitlab.com/gitlab-org/gitlab-runner, history only | 5 | 553 | 96 KB | — | 3 | — | — | — |

A cold read is the index (tens of KB) plus a few hundred bytes per object, never the whole pack. A second read in the
same isolate is about 5 KB and no network. `diff` is 131 ms for two files on GitLab and 757 ms for 89 files on Gitea —
the line diff, not the pack, is what costs.

Three other numbers from the row:

- **Refresh with an unchanged head:** 1.4 s, 2 requests, 94 KB, 0 R2 reads, 0 writes. **Refresh with a moved head:**
  a full clone, because there is no `have`/negotiation yet.
- **History-only clones work on both hosts.** The same GitLab repository at depth 5 is a 4.5 MB pack as a full clone
  and a **96 KB** pack with `filter blob:none`; `log` and `diff` still answer (diff without patches) and `show` fetches
  the one blob it needs — GitLab and Gitea both answer a bare `want <blob>`.
- **Live test in workerd:** `XIN_LIVE=1` passes against `gitlab.com/gitlab-org/gitlab-runner` in 13.2 s for the whole
  test (Durable Object boot, clone, three reads, a diff and a file).

Still missing, by decision rather than by surprise: no incremental fetch, no private repositories (no credentials are
sent), no working-tree diff and no locally computed blame. `diff` on a history-only clone reports which files changed
and leaves the patch out. A repository too large for even a history-only clone is refused with a message.

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

## What is still missing

Four of the six things the prototype listed are now in the row: range reads, refs and the shallow boundary in SQLite,
a pack ceiling with a history-only fallback, and tests plus a spec section. What is left:

1. **Incremental fetch.** A moved head re-downloads the pack. `have` lines or a deepen against the stored head would
   make an update cost the new objects only; nothing in the protocol blocks it, it is simply not written.
2. **Private repositories.** The row sends no credentials and refuses a URL that carries them. A token would have to
   come from the `secrets` service, per project, and the row would need to stop being public-only by construction.
3. **A working-tree diff and local blame.** Both are reads the pack already supports; neither is exposed as a tool.
4. **A tighter ceiling.** 80 MB is a policy set from the prototype's two data points (72 MB worked, 330 MB crashed
   workerd), not a measured edge. The streamed cap has only been exercised with a 1.2 KB limit in a test.

## Where the cost or the limits make it a bad idea

- **Large repositories.** 128 MB of isolate memory is the wall. `next.js` full history (330 MB) crashes the runtime; `linux`, `chromium` and `vscode` are worse. Depth-1 clones of big repositories (47–72 MB) work but cost 9–19 s of download for one commit of history.
- **isomorphic-git as the engine.** 27.5 s for a 10 MB repository in the Worker is not a request budget, it is a job. Use it as the reference for correctness, not as the implementation.
- **One R2 object per git object.** 1,706 writes took 6.8 s; a 32,000-object repository would take minutes and 32,000 Class A operations, for no benefit over two writes.
- **When the only question is "what does this GitHub repository's history say",** the existing API path is one request, ~300 ms, no storage and no cache to invalidate. Native git only pays off for many reads of one repository, for another host, or when a working tree is involved.

## Reproducing

```bash
bun scripts/gate.ts submit test --only=plugins/git-native          # the row: fixture remote, ceiling, offers
XIN_LIVE=1 bun scripts/gate.ts submit test --only=plugins/git-native/live   # the row against gitlab.com

cd test/git-native && bunx wrangler dev --config wrangler.jsonc --port 8801   # the prototype Worker, real R2
curl 'http://127.0.0.1:8801/bench?repo=expressjs/express'                      # clone + log + show + diff, one request
node test/git-native/bench-node.ts repo=expressjs/express impl=native          # the same code in Node, with CPU and heap
```

`fmt`, `lint`, `types`, `bundle` and `test` all pass through the gate on this branch. The prototype is `test/git-native/` plus this report; the shipped row is `plugins/git-native/` with the `git_native` tables in `src/kernel/dbtables.ts` and the `xin-plugin-git-native` bundle in `xin.profile.json`. The only dependency change is the dev dependency `isomorphic-git` (used as the comparison engine, not as the implementation), so nothing in the deployed Worker imports it.

## Two surprises worth recording

- **`node:zlib` in workerd:** `inflateSync(buf, { maxOutputLength: n })` throws `RangeError: Memory limit exceeded` for some `n` (65,536 and 98,304 both fail; 32,768 and 130,048 succeed) even though the output is a few hundred bytes. The same call without `maxOutputLength` works. The reader therefore inflates without the hint and checks the result length against the pack header instead. `inflateSync(buf, { info: true }).engine.bytesWritten` does work, and is how the sequential scan learns each object's compressed length.
- **GitHub's ref advertisement is bigger than the pack.** Protocol v0 sends every ref, including all `refs/pull/*`: 265 KB for `octocat/Hello-World` and ~1.1 MB for `chalk` against a 1.1 MB pack. Protocol v2 (`Git-Protocol: version=2`) with `ls-refs` and `ref-prefix refs/heads/` makes the advertisement 0.2 KB and the listing 23 KB.
