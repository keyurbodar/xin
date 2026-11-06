# 14 · Files

This section decides that file bytes live in R2 behind an `ExecutionEnv` and that pi's own `read`, `write` and `edit` tools run unchanged over it, with no code execution.

Read with: [02 State](./02-state.md) for the `files` index, [06 Orchestration](./06-orchestration.md) for thread file scope, [09 Plugins](./09-plugins.md) for the `files` permission.

```text
class R2Env implements ExecutionEnv {
  id = "owner"                                // pi serializes edit/write per (env.id, path)
  readText / openBinaryReader(path)            // files row → R2.get(r2_key, range)
  writeFile(path, bytes)                       // 1 R2.put("b/"+sha256)  2 upsert files row   (row never points at missing bytes)
  stat / openDirReader(path)                   // index only, no R2 call
  exec()                                       // not_supported → pi's bash is simply not installed
}
```

- **Tools**: pi's built-in `read`, `write` and `edit` run unchanged over R2Env. A `beforeTool` hook enforces scope: a thread writes only under `/projects/<its project>/`, and `/me` is coordinator-only.
- **Uploads from the web** go `PUT /files/*` → Worker streams straight to R2 → one RPC to the DO to commit the row. Bytes never pass through the DO's 128 MB.
- **Content-addressed blobs** mean identical files are stored once. The orphan sweep is a pi task that runs weekly and deletes R2 keys no row references.
- **Library** = `file.list("/projects/<slug>/")`. Artifacts a thread produces are just files it wrote.
