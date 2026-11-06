# 15 · Plugins

This section decides that features ship as bundled plugins reconciled by dependency order, with a narrow `host` facade and permissions as guardrails rather than a sandbox.

Read with: [06 Orchestration](./06-orchestration.md) for the core plugins that implement the orchestrator, [08 Files](./08-files.md) for the `files` permission, [10 Time](./10-time.md) for the `schedules` plugin.

```text
// plugins/web/xin.plugin.json
{ "id":"web", "xin":"^1", "version":"0.1.0",
  "requires":["jobs"], "provides":["tool:web_search","tool:fetch_page"],
  "permissions":{ "net":["*"], "memory":"none", "files":"project" },
  "secrets":[{"key":"SEARCH_API_KEY","label":"Search API key"}],
  "config":{ "type":"object","properties":{"maxResults":{"type":"integer","default":8}} } }

// plugins/web/index.ts
export default definePlugin((host) => ({
  extensions: [defineExtension({ name:"web", tools:[search(host.fetch, host.secret("SEARCH_API_KEY")), fetchPage(host.fetch)] })],
  skills: ["skills/research.md"],
}))
```

| Mechanism | How it works |
| --- | --- |
| Loading | Plugins are bundled at build time (`src/plugins.gen.ts` lists the folders). `plugins` table rows are the enabled set and config. There's no runtime code download in v1. |
| Lifecycle (magpie) | `reconcile()` disposes plugins newest-first, then applies them in `requires`/`provides` order until nothing changes. Each plugin ends `active` or `failed(error)`, and a failed plugin never blocks the others. A changed config re-installs that plugin's extensions under the same name, which pi treats as a hot replace. |
| `host` facade | `fetch` is limited to `permissions.net`. `secret(k)` returns only its own sealed values. `memory` and `files` are scoped by the permission. `ops` runs as the plugin actor. Plugins never see `ctx.storage`. |
| Redaction (pi-pocket) | A core `afterTool` hook replaces any sealed secret value found in tool output before it is stored. |
| Skills | Markdown with frontmatter. Name and description go into one section, and `skill(name)` loads the body on demand. |
| MCP | The `mcp` plugin takes server URLs and uses `pi-mcp`. Tools register as `deferred` with namespace `mcp__<server>__`, and pi's `tool_search` loads them on demand. |
| Per project | `configure({extensions})` on the project's conversations. This is native pi. |
| Trust | Bundled plugins run in-isolate, so permissions are guardrails, not a sandbox. Third-party plugins (later) run in a Worker Loader isolate and reach the same facade over RPC. |

**Core is plugins**: `core-orchestrator` (§8–12), `core-memory`, `core-files`, `core-persona` (sections, `no_reply`, `react`), `jobs`, `web`, `schedules`, `mcp`, `push`.
