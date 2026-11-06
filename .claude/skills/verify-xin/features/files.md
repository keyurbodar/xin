# Files

File bytes live in R2 under content addresses (`b/<sha256>`), indexed by the DO's `files` table. The agent reads and writes them through pi's `read`, `write` and `edit` tools over `R2Env`.

## Sub-features

- Web upload: `PUT /files/<path>` streams to R2, then the Worker commits metadata to the DO.
- Ops: `file.put` (text), `file.list` (prefix), `file.delete` (row only).
- Agent tools: `read`, `write`, `edit` over R2. `/me` writes are coordinator-only.
- Weekly orphan sweep of unreferenced blobs older than 24 h.

## How to get to it (user POV)

The web client uploads with a bearer-authenticated `PUT /files/projects/<slug>/<name>` and lists a project library with `file.list`.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S launch
curl -s -X PUT -H "authorization: Bearer verify-owner-token" --data-binary @some.bin \
  http://127.0.0.1:8799/files/projects/demo/some.bin       # → {path,size,type,sha256}
$S call POST /v1/cmd '{"id":"l1","op":"file.list","args":{"prefix":"/projects/demo"}}'
$S call POST /v1/cmd '{"id":"p1","op":"file.put","args":{"path":"/me/notes.md","text":"hi"}}'
$S call POST /v1/cmd '{"id":"d1","op":"file.delete","args":{"path":"/me/notes.md"}}'
$S stop
```

Proof: the `sha256` in the upload reply equals `sha256sum` of the local file, and `file.list` shows the row with `project` set from the path.

## Gotchas

- An escaping path (`..%2F..`) returns 400 on upload and `bad_args` on ops.
- `POST /v1/files/commit` is internal. Over 4 KiB returns 413, and a key with no R2 bytes returns 409.
- The sweep can't be driven under wrangler dev in reasonable time (24 h grace). `src/files.test.ts` covers it by passing a later `now`.
- Agent tool writes need a model, so drive them through vitest (`src/files.test.ts`), not curl.

Evidence from the last wrangler dev drive: `.verify/evidence/M4-files-after-fix.txt`.
