# 16 · Git: read-only project history

This section decides that a project can point at one GitHub repository and that a coding agent can read its history without a checkout, code execution, write or push.

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

## Row and hiding

The feature is a native Cordis package, `plugins/git`, with one row, `tool-git`, in the `xin-plugin-git` bundle. It injects `pi` and `secrets` and installs the `tool-git` extension. Disabling the row, or a preset that hides it, removes all four tools; a thread inherits its coordinator's preset.

## Not added

- write, commit, branch, checkout, merge or push;
- a clone or local checkout, and therefore no working-tree diff;
- GitLab, Bitbucket or arbitrary git remotes;
- a code-execution environment or a git binary.
