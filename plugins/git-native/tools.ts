import type { JsonValue } from "@earendil-works/chord"
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { compile, int, obj, opt, str } from "@earendil-works/pi-schema"
import { projectInScope } from "../../src/contracts/threaddoc.ts"
import { messageOf } from "../../src/errors.ts"
import { textResult } from "../../src/kernel/index.ts"
import { cloneInto, diff, log, type Port, open, repoId, resolveRef, show } from "./git.ts"
import { remoteUrl } from "./protocol.ts"

const MAX_CHARS = 100_000
const MAX_FILE_BYTES = 400_000

const UrlArg = opt(
  str({
    minLength: 1,
    maxLength: 300,
    description:
      "A public https git remote, for example https://codeberg.org/forgejo/forgejo.git. Defaults to the project's GitHub repository.",
  }),
)
const RefArg = opt(
  str({
    minLength: 1,
    maxLength: 200,
    description: "A branch, tag or commit; defaults to the branch that was cloned.",
  }),
)

const CloneArgs = obj({
  url: UrlArg,
  ref: RefArg,
  depth: opt(
    int({ minimum: 1, maximum: 5000, description: "Commits of history to keep; the whole history by default." }),
  ),
})
const LogArgs = obj({
  url: UrlArg,
  ref: RefArg,
  path: opt(str({ minLength: 1, maxLength: 2_000, description: "Only commits that changed this path." })),
  limit: opt(int({ minimum: 1, maximum: 100, description: "Commits to return, 20 by default." })),
})
const ShowArgs = obj({
  url: UrlArg,
  path: str({ minLength: 1, maxLength: 2_000, description: "The file to read." }),
  ref: RefArg,
})
const DiffArgs = obj({
  url: UrlArg,
  base: str({ minLength: 1, maxLength: 200, description: "The older ref." }),
  head: RefArg,
  path: opt(str({ minLength: 1, maxLength: 2_000, description: "Limit the diff to one path." })),
})

const cloneCheck = compile(CloneArgs)
const logCheck = compile(LogArgs)
const showCheck = compile(ShowArgs)
const diffCheck = compile(DiffArgs)

export type GitNativePort = Port

type Target = { readonly project: string; readonly url: string }

function limit(text: string): string {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}…`
}

const failure = (name: string, error: unknown): ToolExecutionResult =>
  textResult(`${name} failed: ${messageOf(error)}`, { isError: true })

async function targetOf(api: ToolExecutionApi, port: GitNativePort, url: string | undefined): Promise<Target> {
  const scope = await projectInScope(api, api.conversationId)
  if (scope === undefined) throw new Error("this tool needs a project")
  const repo = scope.project.settings.git?.repo
  if (url === undefined && repo === undefined) throw new Error("this tool needs a project repository or a url")
  return {
    project: scope.project.slug,
    url: url === undefined ? `https://github.com/${repo ?? ""}.git` : remoteUrl(url),
  }
}

const summary = (target: Target): string => target.url.replace(/^https?:\/\//, "").replace(/\.git$/, "")

function formatCommits(commits: readonly { sha: string; date: string; author: string; subject: string }[]): string[] {
  return commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.date} ${commit.author} ${commit.subject}`)
}

export function createTools(port: GitNativePort): readonly ToolRegistration[] {
  const clone = defineTool({
    name: "git_native_clone",
    description:
      "Clone or refresh a public git repository inside Xin, from any host (not only GitHub), and keep it in R2. Prefer git_log for GitHub repositories; use this for another host, for full history, or before reading a file at a revision.",
    parameters: CloneArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!cloneCheck.check(args)) return textResult("git_native_clone received invalid arguments", { isError: true })
      try {
        const target = await targetOf(api, port, args.url)
        const cloned = await cloneInto(port, {
          project: target.project,
          url: target.url,
          ...(args.ref === undefined ? {} : { ref: args.ref }),
          ...(args.depth === undefined ? {} : { depth: args.depth }),
        })
        const row = cloned.row
        const head = `${row.branch} ${row.head.slice(0, 7)}`
        const scope = row.partial === 1 ? "history only, no file contents" : "full history"
        const text = cloned.reused
          ? `${summary(target)} is up to date at ${head} (${row.objects} objects, ${(row.pack_bytes / 1024).toFixed(0)} KB, ${scope}).`
          : `cloned ${summary(target)} at ${head}: ${row.objects} objects, ${(row.pack_bytes / 1024).toFixed(0)} KB pack, ${scope}, ${cloned.fetches} requests, ${Math.round(cloned.ms)} ms.`
        return textResult(text, {
          details: {
            url: row.url,
            branch: row.branch,
            head: row.head,
            objects: row.objects,
            packBytes: row.pack_bytes,
            partial: row.partial === 1,
            reused: cloned.reused,
            fetches: cloned.fetches,
            bytes: cloned.bytes,
            ms: Math.round(cloned.ms),
          },
        })
      } catch (error) {
        return failure("git_native_clone", error)
      }
    },
  })

  const commits = defineTool({
    name: "git_native_log",
    description:
      "Read commit history from a cloned public git repository of any host, optionally for one path. Use git_log for a GitHub repository's history; use this for another host or for history the GitHub API will not serve.",
    parameters: LogArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!logCheck.check(args)) return textResult("git_native_log received invalid arguments", { isError: true })
      try {
        const target = await targetOf(api, port, args.url)
        const reader = await open(port, await repoId(target.project, target.url))
        if (reader === undefined)
          return textResult(`git_native_log needs a clone first: run git_native_clone for ${summary(target)}.`, {
            isError: true,
          })
        const result = await log(reader, {
          limit: args.limit ?? 20,
          ...(args.ref === undefined ? {} : { ref: args.ref }),
          ...(args.path === undefined ? {} : { path: args.path }),
        })
        if (result.commits.length === 0)
          return textResult(`no commits in ${summary(target)} match.`, { details: { url: target.url } })
        const head = `Commits on ${summary(target)} (${args.ref ?? reader.row.branch})${args.path === undefined ? "" : ` touching ${args.path}`}:`
        const note = result.truncated
          ? `\n(scanned ${result.scanned} commits; narrow the ref or path for older history)`
          : ""
        return textResult(limit([head, ...formatCommits(result.commits)].join("\n") + note), {
          details: {
            url: target.url,
            ref: args.ref ?? reader.row.branch,
            commits: result.commits.map((commit) => ({
              sha: commit.sha,
              date: commit.date,
              author: commit.author,
              subject: commit.subject,
              parents: [...commit.parents],
            })) as JsonValue,
            scanned: result.scanned,
            truncated: result.truncated,
          },
        })
      } catch (error) {
        return failure("git_native_log", error)
      }
    },
  })

  const file = defineTool({
    name: "git_native_show",
    description:
      "Read one file at a revision from a cloned public git repository of any host. Use git_show for a GitHub commit; use this for another host or for a file at a specific commit.",
    parameters: ShowArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!showCheck.check(args)) return textResult("git_native_show received invalid arguments", { isError: true })
      try {
        const target = await targetOf(api, port, args.url)
        const reader = await open(port, await repoId(target.project, target.url))
        if (reader === undefined)
          return textResult(`git_native_show needs a clone first: run git_native_clone for ${summary(target)}.`, {
            isError: true,
          })
        const shown = await show(port, reader, {
          path: args.path,
          ...(args.ref === undefined ? {} : { ref: args.ref }),
        })
        const body = shown.bytes > MAX_FILE_BYTES ? `(${shown.bytes} bytes, too large to print)` : shown.text
        return textResult(
          limit(
            [
              `${shown.path} at ${args.ref ?? reader.row.branch} (${shown.sha.slice(0, 7)}, ${shown.bytes} bytes):`,
              "",
              body,
            ].join("\n"),
          ),
          {
            details: { url: target.url, path: shown.path, sha: shown.sha, bytes: shown.bytes },
          },
        )
      } catch (error) {
        return failure("git_native_show", error)
      }
    },
  })

  const compare = defineTool({
    name: "git_native_diff",
    description:
      "Compare two revisions of a cloned public git repository of any host, with file patches when the clone has file contents. Use git_diff for GitHub; use this for another host, or between any two commits without the GitHub compare limits.",
    parameters: DiffArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!diffCheck.check(args)) return textResult("git_native_diff received invalid arguments", { isError: true })
      try {
        const target = await targetOf(api, port, args.url)
        const reader = await open(port, await repoId(target.project, target.url))
        if (reader === undefined)
          return textResult(`git_native_diff needs a clone first: run git_native_clone for ${summary(target)}.`, {
            isError: true,
          })
        const files = await diff(reader, {
          base: await resolveRef(reader, args.base),
          head: args.head ?? reader.row.branch,
          ...(args.path === undefined ? {} : { path: args.path }),
        })
        const lines = files.map((entry) => {
          const patch = entry.patch === null ? "  (no patch: this clone keeps history only)" : entry.patch
          return `--- ${entry.path} (${entry.status})\n${patch}`
        })
        const head = `${summary(target)} ${args.base}...${args.head ?? reader.row.branch}: ${files.length} file${files.length === 1 ? "" : "s"} changed`
        return textResult(limit([head, "", ...lines].join("\n")), {
          details: {
            url: target.url,
            base: args.base,
            head: args.head ?? reader.row.branch,
            files: files.map((entry) => ({
              path: entry.path,
              status: entry.status,
              patch: entry.patch !== null,
            })) as JsonValue,
          },
        })
      } catch (error) {
        return failure("git_native_diff", error)
      }
    },
  })

  return [clone, commits, file, compare]
}
