# 14 · Files

This section decides that file bytes live in R2 behind an `ExecutionEnv` and that pi's own `read`, `write` and `edit` tools run unchanged over it, with no code execution.

Read with: [02 State](./02-state.md) for the `files` index, [06 Orchestration](./06-orchestration.md) for thread file scope, [09 Plugins](./09-plugins.md) for the `files` permission.

```text
class R2Env implements ExecutionEnv {
  id = "owner"                                // pi serializes edit/write per (env.id, path)
  readText / openBinaryReader(path)            // files row → R2.get(r2_key, range)
  writeFile(path, bytes)                       // 1 R2.put("b/"+sha256)  2 upsert files row   (row never points at missing bytes)
  stat / openDirReader(path)                   // index only, no R2 call
  exec()                                       // shell_unavailable → pi's bash is simply not installed
  watch()                                      // not_supported (R2 has no change feed)
}
```

- **Tools**: pi's built-in `read`, `write` and `edit` run unchanged over R2Env. A `beforeTool` hook enforces scope through a `WriteScope` function: `/me` is coordinator-only, and a thread's file access is confined to `/projects/<its project>/`. The hook resolves a tool's path against the conversation's `cwd`, the same value the env is built with, and blocks a path that escapes the files root. `file.list`, `file.read`, `file.revision`, `file.revisions`, `file.put` and `file.delete` run the same scope, so a plugin or thread actor cannot read or write another project's files or `/me`.
- **Uploads from the web** are capped at 50 MB (`413` with `maxBytes`), the size the D8 frame shows; the client refuses a larger file before it starts, so the chip turns red instead of a request failing silently. They go `PUT /files/<path>` → the Worker hashes the stream into a staging key `tmp/<uuid>`, copies it to `b/<sha256>` (always, which refreshes the blob's `uploaded` timestamp), then makes one `POST /v1/files/commit` call to the DO with metadata only (capped at 4 KiB). The DO checks `r2Key = b/<sha256>` and that R2 holds that many bytes before it writes the row. Bytes never pass through the DO's 128 MB. A request without `content-length` is buffered in the Worker instead.
- **Images in a turn** are read back from R2 by intake, never stored in the transcript: at most 1 MiB of raw bytes per turn goes to a vision model as base64, and a file over the remaining budget is named but not inlined (04).
- **Content-addressed blobs** mean identical files are stored once, and every write puts the blob again so `uploaded` reflects the latest reference. The orphan sweep runs weekly from the files module's `due`/`fire` (kv `files:sweep_at`): it deletes `b/` keys no row references and `tmp/` staging keys, skipping anything younger than 24 h so an upload between its R2 put and its commit is never swept. For each `b/` candidate it rechecks the head, the age and the row inside `blockConcurrencyWhile` before deleting, so a commit that lands mid-sweep is never raced. `file.delete` drops only the row and leaves the blob to the sweep.
- **Library** = `file.list("/projects/<slug>/")`. Artifacts a thread produces are just files it wrote.
- **Reading one back** = `file.read(path)`: the index entry plus `text` for a previewable type (anything `text/*`, JSON, XML, SVG) and `null` for the rest, plus `versions`. It runs the same write scope as the other file ops.
- **Versions** = `file_revisions` keeps the last five contents a path had before an overwrite (path, sha256, size, type, at). A revision's blob stays referenced, so the orphan sweep keeps it; `file.revisions` lists them and `file.revision {path, sha256}` returns one with its text.
