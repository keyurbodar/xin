# 16 · Git: read-only project history

This section decides that a project can point at one GitHub repository and that a coding agent can read its history without a checkout, code execution, write or push. An optional second row clones a public repository of any host into R2 and reads it there ([Native git](#native-git-optional-row)).

Read with: [06 Orchestration](./06-orchestration.md) for threads, [09 Plugins](./09-plugins.md) for rows and presets, [14 Client](./14-client.md) for project settings.

```text
project.settings.git = { repo: "owner/name", ref?: "main" }
tool-git row (bundle xin-plugin-git)
  git_log   { path?, ref?, limit? }   -> commits
  git_show  { ref }                   -> one commit and file patches
  git_diff  { base, head?, path? }    -> comparison and patches
  git_blame { path, ref? }            -> line ranges and their commits
```

## Scope

The tools resolve the caller's project with the same `projectInScope` used by files, threads and memory. A project coordinator and every thread in that project use the project's repository; the root chat has no project and gets a tool error. There is no `repo` parameter on a tool, so a thread cannot read another project's repository.

`project.settings.git.repo` is `owner/name` and `ref` is optional, defaulting to `HEAD`. The owner sets it through `project.update { id, settings: { git } }`; it is project configuration, not a permission prompt. A project without `git` gets a clear "needs a project repository" tool error.

## Tools

All four are read-only and `replay:"safe"`:

| Tool | GitHub call | Result |
| --- | --- | --- |
| `git_log` | `GET /repos/{repo}/commits?sha={ref}&path={path}&per_page={limit}` | Short sha, date, author and first line; `details.commits` carries the same rows. |
| `git_show` | `GET /repos/{repo}/commits/{ref}` | Commit header, message and file patches. |
| `git_diff` | `GET /repos/{repo}/compare/{base}...{head}` | Status, ahead/behind counts, commits and file patches; `path` filters files. |
| `git_blame` | GitHub GraphQL `repository.object(expression: ref).blame(path)` | Line ranges with the commit that last changed them. |

`git_blame` needs a named credential `github.token` for the GraphQL API. The other three work unauthenticated on public repositories and use the same token when it exists, for private repositories and higher rate limits. The tools send a `Xin/0.1` user agent and the GitHub API version header, cap output at 100,000 characters and time out at 15 seconds.

A ref is encoded one path segment at a time, and a ref with an empty, `.` or `..` segment, a backslash or a `%` is refused before any request: `git_show` and `git_diff` put the ref in the URL path, so `../..` would otherwise walk out of `/repos/{repo}/` and reach another repository with the home's token.

## Row and hiding

The feature is a native Cordis package, `plugins/git`, with one row, `tool-git`, in the `xin-plugin-git` bundle. It injects `pi` and `secrets` and installs the `tool-git` extension. The bundle declares the row `disabled: true` (`plugins/git/package.json`, carried into `src/catalog.gen.ts`): git access is an optional plugin and off by default, but the row is in the tree so `plugin.list` shows it and `plugin.enable` mounts it without a rebuild. `xin.profile.json` names the bundle and carries no row state; the disabled flag lives on the row. Disabling the row again, or a preset that hides it, removes all four tools; a thread inherits its coordinator's preset.

## Native git (optional row)

A second row, `tool-git-native` in the `xin-plugin-git-native` bundle, reads a public repository of **any** host inside
the Worker: one smart-HTTP v2 fetch, a git-format `.idx` built with `node:zlib`, the pack and its index in R2, and a
reader that pulls one object at a time by R2 range read. There is no git binary, no checkout and no dependency.

```text
tool-git-native row (bundle xin-plugin-git-native, disabled: true)
  git_native_clone { url?, ref?, depth? }   -> clone or refresh into R2
  git_native_log   { url?, ref?, path?, limit? }
  git_native_show  { url?, path, ref? }     -> one file at a revision
  git_native_diff  { url?, base, head?, path? }
```

`url` is any public `http(s)` git remote and defaults to the project's GitHub repository, so a GitHub project keeps one
setting; the GitHub API tools stay the default path for GitHub and are cheaper (one request, no storage). The row is
project-scoped like the API tools: storage is keyed by project slug and URL, so a thread reads only what its own
project cloned.

State lives in SQLite (`git_native_repo`, `git_native_ref`, `git_native_shallow`, applied by the row's own migration
`git_native`), so a read resolves a ref and the shallow boundary without touching the pack. R2 holds three objects per
repository: the pack, the v2 `.idx`, and a span table (offset and length per object). A pack up to 2 MB is kept whole in
the isolate; a larger one is read by range, so a cold read costs the index (tens of KB) and a few hundred bytes per
object instead of the whole pack.

Limits, measured on 2026-11-10: a clone of `gitlab.com/gitlab-org/gitlab-runner` at depth 5 (2,420 objects, 4.5 MB)
takes 4.9 s, a first read 13 ms and a second read in the same isolate 4 ms with no network. The pack ceiling is 80 MB;
past it the row retries with `filter blob:none`, which keeps commits and trees and drops file contents, so `log` and
`diff` still answer and `show` fetches the one blob it needs. A repository too large even for that is refused with a
message instead of crashing the isolate (a 330 MB pack did crash workerd in the prototype).

A refresh is cheap only when nothing changed: two requests and no pack. When the head moved, the row re-clones the pack
it asked for; there is no `have`/negotiation yet, so an update costs a full download.

## Not added

- write, commit, branch, checkout, merge or push;
- private repositories: the native row sends no credentials and reads public remotes only;
- a working-tree diff (the files plugin's bytes against a commit) and `blame` computed locally;
- an incremental fetch: a moved head re-downloads the pack;
- a code-execution environment or a git binary.
