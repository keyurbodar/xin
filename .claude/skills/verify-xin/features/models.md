# Models and credentials

No model ids in code. The catalog comes from pi-ai at run time, filtered to providers with working auth. Credentials are sealed with the `KEK` in the `credentials` table. A switch applies at the next model request.

## Sub-features

- `credential.set {provider, key}` or `{provider, custom:{baseUrl, key, api}}`, and `credential.delete {provider}`. The key is never echoed.
- `models.list {query?}`: favorites, recent, current, then the rest, capped with `omittedModels`.
- `conv.configure {conv?, model?, thinking?}`: an unknown model gives a `bad_args` ack.
- `owner.defaults {role, model}` with role chat | thread | utility.
- The `set_model` tool (this_chat, thread:<id>) for natural-language switches.

## How to get to it (user POV)

Settings: paste a provider key. The composer picker lists models. "use X for this" in chat switches through `set_model`.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"m3-1","op":"credential.set","args":{"provider":"openrouter","key":"sk-verify-not-real"}}'
$S call POST /v1/cmd '{"id":"m3-2","op":"models.list","args":{"query":"openrouter"}}'        # catalog entries for that provider
$S call POST /v1/cmd '{"id":"m3-3","op":"conv.configure","args":{"model":{"provider":"openrouter","modelId":"does-not-exist"}}}'   # bad_args
$S call POST /v1/cmd '{"id":"m3-4","op":"credential.delete","args":{"provider":"openrouter"}}'
```

The mid-run switch, the compaction after a switch to a smaller window and the sealed row are proven in `plugins/models/models.test.ts`. A real model answering needs a real key: the live run (`XIN_LIVE=1`).

## Gotchas

- A fake key still lists the provider's catalog, because the auth check is "a credential exists", not a network probe.

Evidence from the last wrangler dev drive: `.verify/evidence/M3-models.txt` and the mid-run switch in `.verify/evidence/M5-live.txt`.
