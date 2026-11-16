# 15 · Web: search and page fetch

This section decides that Ingle can search the public web and read a page as text, through two built-in tools and one normal feature row. It does not add a browser, JavaScript rendering, authenticated pages or code execution.

Read with: [06 Orchestration](./06-orchestration.md) for the job wrapper, [08 Files](./08-files.md) for the separate file scope, [09 Plugins](./09-plugins.md) for rows and presets.

```text
tool-web row (bundle ingle-plugin-web, row id tool-web)
  installs the tool-web extension, republished when the brave_search secret changes
  web_fetch(url, maxChars?, offset?) -> title, content type, one window of readable text   always
  web_search(query, maxResults?)  -> titles, URLs, snippets                                once brave_search is set
```

## Tools

| Tool         | Input                                                                                                      | Result                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `web_search` | `query` (1–500 chars), `maxResults` (1–10, default 5)                                                      | A numbered list of title, URL and snippet; `details.results` carries the same array.                                 |
| `web_fetch`  | `url` (public http or https), `maxChars` (1,000–100,000, default 8,000), `offset` (integer ≥ 0, default 0) | Title, content type and the readable text in `[offset, offset + maxChars)`; non-text responses return metadata only. |

Both tools are deferred: the prompt's `deferred-tools` index lists them and `tool_search` loads one on first use. Both are wrapped with `jobs.tool`, so a call that takes longer than the 8 s inline wait becomes a job and reports its result later. In a thread the wrapper waits inline until the thread's deadline. They are read-only: no file is written and no project data is read.

## Search

`web_search` calls the Brave Search API: `GET https://api.search.brave.com/res/v1/web/search?q=<query>&count=<maxResults>` with `X-Subscription-Token: <key>` and `Accept: application/json`. The key is the secret ref `brave_search`, which the owner sets with `secret.set`; the row reads it with `ctx.secrets.get`, as `tool-git` does. Each of `web.results[]` becomes a result: `title` and `description` have their tags stripped and entities decoded, then the title is capped at 300 characters and the snippet at 1,000 (a cut ends in `…`). A result whose `url` is not http(s) is dropped. A non-2xx answer, a body over 1 MB or a shape other than `{ web?: { results: [...] } }` is a tool error, and so is an empty result set.

Without the key, `web_search` is not installed at all: it is in no request and not in the deferred index. `secret.set` emits `credentials/updated`, and the row reinstalls its extension when the ref is `brave_search` (the way `tool-mcp` republishes on `mcp/changed`), so the next request carries it with no restart. There is one provider and no fallback; the earlier DuckDuckGo HTML scraping is removed.

## Fetch

`web_fetch` validates the URL at the boundary:

- only `http:` and `https:`, on the default ports (80 and 443);
- no credentials in the URL;
- only public hosts: loopback, private, link-local, CGNAT, multicast, benchmark and IPv6 ULA/link-local ranges are refused, as are numeric and octal/hex host forms that could resolve to them. The host is lowercased and a trailing dot is removed before the check, so `localhost.` is judged as `localhost`;
- the final URL after redirects is checked again.

The body is capped at 2 MiB and the request at 15 s. HTML is reduced to a title and readable text: comments, scripts, styles, templates, SVG, iframes, objects and embeds are removed; block endings become line breaks; tags are stripped; entities are decoded; whitespace is normalised. Text, JSON and XML are returned as text the same way.
The model sees one window of that text per call, 8,000 characters by default, because a tool result stays in the prompt on every later request of the conversation. When more text remains, the result ends with one line, `[Showing characters 0–8000 of 23,410. Call web_fetch again with offset 8000 for more.]`, and `details` carries `offset`, `nextOffset` (`null` on the last window) and `totalChars`. An `offset` at or past the end returns empty text and `[Offset 30000 is past the end: the page has 23,410 characters.]`. The total is measured on the text read within the 2 MiB body cap. A binary response returns its URL and content type with `text: null`.

## Row and scoping

The feature is a native Cordis package, `plugins/web`, with one row, `tool-web`, in the `ingle-plugin-web` bundle. The row injects `pi`, `jobs` and `secrets` (manifest permissions `network` and `secrets`, `credentials: ["brave_search"]`) and installs the `tool-web` extension. The bundle row ships enabled (`plugins/web/package.json`, carried into `src/catalog.gen.ts`). That is an exception to the scope rule that optional access rows ship off, decided by Bosun, 2026-11-16, under Keyur's standing authority, for Capy parity; `ingle-plugin-git` still ships disabled. `ingle.profile.json` names the bundle and carries no row state. The owner can still turn the row off with `plugin.enable`, and a preset can hide it for one scope.

`tool-web` is the first row that holds `secrets` by default, so its manifest limits it to its own ref: `credentials: ["brave_search"]`. The secrets facade (`src/kernel/facade.ts`) refuses `get` and `set` on any other ref, so the row cannot read or overwrite the owner's other credentials. A row that declares no `credentials` keeps every ref; `mcp-server` and `deploy-hook` stay that way because the refs they read are named in owner-written config. As the manifest notes, rows run in the Home's isolate, so the check keeps honest code to its declaration and does not confine hostile code.

## Cost

With no key the row adds one deferred-index line to every request's system prompt, `- web_fetch: Fetch a public http or https page as readable text.` (65 B). With a key it adds a second, `- web_search: Search the public web.` (37 B), 102 B in all. Neither tool schema is sent until `tool_search` loads it. Each call is one outbound subrequest (`web_fetch` may follow redirects within that fetch) and writes no rows; the result itself stays in the transcript like any tool result, which is why `web_fetch` windows at 8,000 characters.

The tools follow the same scoping rules as the rest of the agent:

- they are available to the root chat, a project coordinator and a thread;
- a preset can hide the `tool-web` row from a conversation, and a thread inherits its coordinator's preset;
- a thread still cannot write files outside its project because the web tools write no files at all. The file scope in [08 Files](./08-files.md) is unchanged.

No approval prompt, permission gate or click-through is added. The URL policy is a correctness boundary, not a user decision.

## Not added

- a browser or JavaScript rendering;
- authenticated pages, cookies or a logged-in session;
- a second search provider, a provider setting or a keyless fallback;
- page caching, embeddings or an index;
- a second fetch path through `r.jina.ai` or another proxy.
