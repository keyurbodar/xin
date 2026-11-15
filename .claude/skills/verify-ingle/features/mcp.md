# MCP servers

The owner adds remote MCP servers (Streamable HTTP). Their tools appear as deferred tools `mcp__<server>__<tool>`, loaded through pi's `tool_search`. Headers are sealed in kv `mcp:<name>`.

## Sub-features

- `mcp.add` (`name`, `url`, optional `headers`): connects, caches the tool list, and keeps the server even when the first connect fails. `url` must be `https://` and may not carry a username or password; anything else is rejected with `bad_args`.
- `mcp.list`: name, url (origin and path only, never the query string), tool count and last error. Never returns headers. A row that does not parse is listed as `{ name, error: "corrupt" }`.
- `mcp.remove`.
- Cold open registers cached tools without a network call, then refreshes in the background. A refresh writes only if the stored row is unchanged, so it cannot resurrect a removed server.

## How to get to it (user POV)

The settings view has an MCP section to add a server URL and an auth header.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"a0","op":"mcp.add","args":{"name":"plain","url":"http://127.0.0.1:9/mcp"}}'   # bad_args: https only
$S call POST /v1/cmd '{"id":"a1","op":"mcp.add","args":{"name":"demo","url":"https://mcp.invalid/mcp","headers":{"authorization":"Bearer x"}}}'
$S call POST /v1/cmd '{"id":"l1","op":"mcp.list","args":{}}'      # error shown, no headers
$S call POST /v1/cmd '{"id":"r1","op":"mcp.remove","args":{"name":"demo"}}'
```

Tool discovery and `tools/call` are proven in `plugins/mcp/mcp.test.ts` against an in-process fake MCP server.

## Gotchas

- An unreachable URL gives `tools: 0` and an `error`, not a rejection.

Evidence from the last wrangler dev drive: `.verify/evidence/M8-mcp-after-fix.txt`.
