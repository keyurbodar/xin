# 15 · Web: search and page fetch

This section decides that Xin can search the public web and read a page as text, through two built-in tools and one normal feature row. It does not add a browser, JavaScript rendering, authenticated pages or code execution.

Read with: [06 Orchestration](./06-orchestration.md) for the job wrapper, [08 Files](./08-files.md) for the separate file scope, [09 Plugins](./09-plugins.md) for rows and presets.

```text
tool-web row (bundle xin-plugin-web, row id tool-web)
  installs the tool-web extension with two tools
  web_search(query, maxResults?)  -> titles, URLs, snippets
  web_fetch(url, maxChars?)       -> title, content type, readable text
```

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `web_search` | `query` (1–500 chars), `maxResults` (1–10, default 5) | A numbered list of title, URL and snippet; `details.results` carries the same array. |
| `web_fetch` | `url` (public http or https), `maxChars` (1,000–100,000, default 20,000) | Title, content type and readable text; non-text responses return metadata only. |

Both tools are wrapped with `jobs.tool`, so a call that takes longer than the 8 s inline wait becomes a job and reports its result later. In a thread the wrapper waits inline until the thread's deadline. They are read-only: no file is written and no project data is read.

## Search

`web_search` reads DuckDuckGo's HTML endpoint (`https://html.duckduckgo.com/html/`) with no API key. It parses `result__a` anchors and `result__snippet` text, decodes entities and follows DuckDuckGo's `uddg` redirect parameter to the target URL. Internal DuckDuckGo links and non-http(s) targets are dropped. An empty result set is a tool error, not a silent success. There is no second search provider and no API-key setting; a provider with a key can arrive as a plugin later.

## Fetch

`web_fetch` validates the URL at the boundary:

- only `http:` and `https:`, on the default ports (80 and 443);
- no credentials in the URL;
- only public hosts: loopback, private, link-local, CGNAT, multicast, benchmark and IPv6 ULA/link-local ranges are refused, as are numeric and octal/hex host forms that could resolve to them;
- the final URL after redirects is checked again.

The body is capped at 2 MiB and the request at 15 s. HTML is reduced to a title and readable text: comments, scripts, styles, templates, SVG, iframes, objects and embeds are removed; block endings become line breaks; tags are stripped; entities are decoded; whitespace is normalised. Text, JSON and XML are returned as text within `maxChars`. A binary response returns its URL and content type with `text: null`.

## Row and scoping

The feature is a native Cordis package, `plugins/web`, with one row, `tool-web`, in the `xin-plugin-web` bundle. The row injects `pi` and `jobs` and installs the `tool-web` extension. It is enabled in `xin.profile.json` like every other feature.

The tools follow the same scoping rules as the rest of the agent:

- they are available to the root chat, a project coordinator and a thread;
- a preset can hide the `tool-web` row from a conversation, and a thread inherits its coordinator's preset;
- a thread still cannot write files outside its project because the web tools write no files at all. The file scope in [08 Files](./08-files.md) is unchanged.

No approval prompt, permission gate or click-through is added. The URL policy is a correctness boundary, not a user decision.

## Not added

- a browser or JavaScript rendering;
- authenticated pages, cookies or a logged-in session;
- a search API key or provider setting;
- page caching, embeddings or an index;
- a second fetch path through `r.jina.ai` or another proxy.
