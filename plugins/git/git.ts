import type { JsonValue } from "@earendil-works/chord"
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { arr, compile, int, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import { projectInScope } from "../../src/contracts/threaddoc.ts"
import { messageOf } from "../../src/errors.ts"
import { textResult } from "../../src/kernel/index.ts"

const API = "https://api.github.com"
const TOKEN_REF = "github.token"
const TIMEOUT_MS = 15_000
const MAX_CHARS = 100_000

const CommitAuthorSchema = obj({ name: str(), date: str() }, { open: true })
const CommitSummarySchema = obj(
  {
    sha: str({ minLength: 1 }),
    commit: obj({ message: str(), author: opt(CommitAuthorSchema) }, { open: true }),
    author: opt(obj({ login: str() }, { open: true })),
  },
  { open: true },
)
const CommitFileSchema = obj(
  {
    filename: str({ minLength: 1 }),
    status: str(),
    additions: opt(int({ minimum: 0 })),
    deletions: opt(int({ minimum: 0 })),
    patch: opt(str()),
  },
  { open: true },
)
const CommitDetailSchema = obj(
  {
    sha: str({ minLength: 1 }),
    commit: obj({ message: str(), author: opt(CommitAuthorSchema) }, { open: true }),
    files: opt(arr(CommitFileSchema)),
  },
  { open: true },
)
const CompareSchema = obj(
  {
    status: str(),
    ahead_by: opt(int({ minimum: 0 })),
    behind_by: opt(int({ minimum: 0 })),
    total_commits: opt(int({ minimum: 0 })),
    files: opt(arr(CommitFileSchema)),
    commits: opt(arr(CommitSummarySchema)),
  },
  { open: true },
)
const LogSchema = arr(CommitSummarySchema)
const logCheck = compile(LogSchema)
const showCheck = compile(CommitDetailSchema)
const compareCheck = compile(CompareSchema)

const LogArgs = obj({
  path: opt(str({ minLength: 1, maxLength: 2_000, description: "Limit history to one path." })),
  ref: opt(str({ minLength: 1, maxLength: 200, description: "A branch, tag or commit; defaults to the project ref." })),
  limit: opt(int({ minimum: 1, maximum: 100, description: "Commits to return, 20 by default." })),
})
const ShowArgs = obj({
  ref: str({ minLength: 1, maxLength: 200, description: "A branch, tag or commit to show." }),
})
const DiffArgs = obj({
  base: str({ minLength: 1, maxLength: 200, description: "The older ref." }),
  head: opt(str({ minLength: 1, maxLength: 200, description: "The newer ref; defaults to the project ref." })),
  path: opt(str({ minLength: 1, maxLength: 2_000, description: "Limit the diff to one path." })),
})
const BlameArgs = obj({
  path: str({ minLength: 1, maxLength: 2_000, description: "The file to blame." }),
  ref: opt(str({ minLength: 1, maxLength: 200, description: "A branch, tag or commit; defaults to the project ref." })),
})
const logArgsCheck = compile(LogArgs)
const showArgsCheck = compile(ShowArgs)
const diffArgsCheck = compile(DiffArgs)
const blameArgsCheck = compile(BlameArgs)

type GitSettings = { readonly repo: string; readonly ref: string }
type CommitSummary = Static<typeof CommitSummarySchema>
type CommitFile = Static<typeof CommitFileSchema>

export type GitPort = { readonly secrets: { get(ref: string): string | undefined } }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const textOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

function limit(text: string): string {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}…`
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? ""
}

function tokenOf(port: GitPort): string | undefined {
  const value = port.secrets.get(TOKEN_REF)
  return value === undefined || value === "" ? undefined : value
}

async function request(
  path: string,
  token: string | undefined,
  init: { readonly method?: string; readonly body?: string } = {},
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("the GitHub request timed out")), TIMEOUT_MS)
  try {
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Xin/0.1",
        "x-github-api-version": "2022-11-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      let message = text
      try {
        const value: unknown = JSON.parse(text)
        if (isRecord(value)) message = textOf(value.message) ?? text
      } catch {
        // Keep the response text.
      }
      throw new Error(`GitHub answered ${response.status}: ${message}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error("GitHub returned invalid JSON")
    }
  } finally {
    clearTimeout(timer)
  }
}

async function graphql(query: string, variables: Record<string, string>, token: string): Promise<unknown> {
  return request("/graphql", token, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  })
}

async function projectGit(api: ToolExecutionApi): Promise<GitSettings | undefined> {
  const scope = await projectInScope(api, api.conversationId)
  const git = scope?.project.settings.git
  if (git === undefined) return undefined
  return { repo: git.repo, ref: git.ref ?? "HEAD" }
}

function repoParts(repo: string): { readonly owner: string; readonly name: string } {
  const [owner, name] = repo.split("/")
  if (owner === undefined || name === undefined || owner === "." || owner === ".." || name === "." || name === "..")
    throw new Error(`the project repository "${repo}" is invalid`)
  return { owner, name }
}

function repoPath(repo: string): string {
  const { owner, name } = repoParts(repo)
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** A ref is one path segment or more, encoded: `..` would walk out of the repository's commits path. */
function refPath(ref: string): string {
  const parts = ref.split("/")
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.includes("\\") || part.includes("%"))
      throw new Error(`the ref "${ref}" is invalid`)
  }
  return parts.map((part) => encodeURIComponent(part)).join("/")
}

function formatCommit(commit: CommitSummary): string {
  const author = commit.author?.login ?? commit.commit.author?.name ?? "unknown"
  const date = commit.commit.author?.date ?? ""
  return `${commit.sha.slice(0, 7)} ${date} ${author} ${firstLine(commit.commit.message)}`
}

function formatFiles(files: readonly CommitFile[]): string {
  return files
    .map((file) => {
      const stats = `+${file.additions ?? 0} -${file.deletions ?? 0}`
      return `--- ${file.filename} (${file.status}, ${stats})\n${file.patch ?? "(no patch returned)"}`
    })
    .join("\n\n")
}

function commitDetails(commit: CommitSummary): JsonValue {
  return {
    sha: commit.sha,
    author: commit.author?.login ?? commit.commit.author?.name ?? null,
    date: commit.commit.author?.date ?? null,
    message: commit.commit.message,
  }
}

function fileDetails(file: CommitFile): JsonValue {
  return {
    path: file.filename,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  }
}

function toolFailure(name: string, error: unknown): ToolExecutionResult {
  return textResult(`${name} failed: ${messageOf(error)}`, { isError: true })
}

export function createTools(port: GitPort): readonly ToolRegistration[] {
  const log = defineTool({
    name: "git_log",
    description:
      "Read a project's GitHub commit history. Optionally limit to one path and choose a branch, tag or commit.",
    parameters: LogArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!logArgsCheck.check(args)) return textResult("git_log received invalid arguments", { isError: true })
      try {
        const git = await projectGit(api)
        if (git === undefined) return textResult("git_log needs a project repository.", { isError: true })
        const ref = args.ref ?? git.ref
        const query = new URLSearchParams({ per_page: String(args.limit ?? 20), sha: ref })
        if (args.path !== undefined) query.set("path", args.path)
        const value = await request(`/repos/${repoPath(git.repo)}/commits?${query.toString()}`, tokenOf(port))
        if (!logCheck.check(value)) throw new Error("GitHub returned an invalid commit list")
        return textResult(limit([`Commits on ${git.repo} (${ref}):`, ...value.map(formatCommit)].join("\n")), {
          details: { repo: git.repo, ref, commits: value.map(commitDetails) },
        })
      } catch (error) {
        return toolFailure("git_log", error)
      }
    },
  })

  const show = defineTool({
    name: "git_show",
    description: "Read one GitHub commit, including its message and file patches.",
    parameters: ShowArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!showArgsCheck.check(args)) return textResult("git_show received invalid arguments", { isError: true })
      try {
        const git = await projectGit(api)
        if (git === undefined) return textResult("git_show needs a project repository.", { isError: true })
        const value = await request(`/repos/${repoPath(git.repo)}/commits/${refPath(args.ref)}`, tokenOf(port))
        if (!showCheck.check(value)) throw new Error("GitHub returned an invalid commit")
        const files = value.files ?? []
        return textResult(
          limit(
            [
              `${value.sha} ${value.commit.author?.date ?? ""} ${value.commit.author?.name ?? ""}`,
              firstLine(value.commit.message),
              "",
              formatFiles(files),
            ].join("\n"),
          ),
          { details: { repo: git.repo, ref: args.ref, sha: value.sha, files: files.map(fileDetails) } },
        )
      } catch (error) {
        return toolFailure("git_show", error)
      }
    },
  })

  const diff = defineTool({
    name: "git_diff",
    description: "Read the diff between two GitHub refs in the project repository.",
    parameters: DiffArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!diffArgsCheck.check(args)) return textResult("git_diff received invalid arguments", { isError: true })
      try {
        const git = await projectGit(api)
        if (git === undefined) return textResult("git_diff needs a project repository.", { isError: true })
        const head = args.head ?? git.ref
        const value = await request(
          `/repos/${repoPath(git.repo)}/compare/${refPath(args.base)}...${refPath(head)}`,
          tokenOf(port),
        )
        if (!compareCheck.check(value)) throw new Error("GitHub returned an invalid comparison")
        const files = (value.files ?? []).filter((file) => args.path === undefined || file.filename === args.path)
        return textResult(
          limit(
            [
              `${git.repo} ${args.base}...${head}: ${value.status}, ahead ${value.ahead_by ?? 0}, behind ${value.behind_by ?? 0}`,
              `${value.total_commits ?? 0} commits`,
              "",
              formatFiles(files),
            ].join("\n"),
          ),
          {
            details: {
              repo: git.repo,
              base: args.base,
              head,
              status: value.status,
              aheadBy: value.ahead_by ?? 0,
              behindBy: value.behind_by ?? 0,
              files: files.map(fileDetails),
            },
          },
        )
      } catch (error) {
        return toolFailure("git_diff", error)
      }
    },
  })

  const blame = defineTool({
    name: "git_blame",
    description:
      "Read line attribution for one file in the project's GitHub repository. Needs a github.token named credential.",
    parameters: BlameArgs,
    replay: "safe",
    execute: async (args, api) => {
      if (!blameArgsCheck.check(args)) return textResult("git_blame received invalid arguments", { isError: true })
      try {
        const git = await projectGit(api)
        if (git === undefined) return textResult("git_blame needs a project repository.", { isError: true })
        const token = tokenOf(port)
        if (token === undefined)
          return textResult("git_blame needs a github.token named credential for the GitHub GraphQL API.", {
            isError: true,
          })
        const { owner, name } = repoParts(git.repo)
        const ref = args.ref ?? git.ref
        const query = [
          "query($owner:String!,$name:String!,$expression:String!,$path:String!){",
          "repository(owner:$owner,name:$name){object(expression:$expression){... on Commit{",
          "blame(path:$path){ranges{startingLine endingLine commit{oid abbreviatedOid message author{name date}}}}",
          "}}}}",
        ].join("")
        const value = await graphql(query, { owner, name, expression: ref, path: args.path }, token)
        if (!isRecord(value) || !isRecord(value.data)) throw new Error("GitHub returned an invalid blame result")
        const repository = value.data.repository
        if (!isRecord(repository) || !isRecord(repository.object)) throw new Error("the ref has no blame")
        const blameValue = repository.object.blame
        if (!isRecord(blameValue) || !Array.isArray(blameValue.ranges)) throw new Error("the ref has no blame")
        const ranges = blameValue.ranges.filter(isRecord).map((range) => ({
          start: typeof range.startingLine === "number" ? range.startingLine : 0,
          end: typeof range.endingLine === "number" ? range.endingLine : 0,
          commit: isRecord(range.commit) ? range.commit : {},
        }))
        const lines = ranges.map((range) => {
          const commit = range.commit
          const author = isRecord(commit.author) ? commit.author : {}
          const oid = textOf(commit.oid) ?? "unknown"
          return `${range.start}-${range.end} ${oid.slice(0, 7)} ${textOf(author.name) ?? ""} ${textOf(author.date) ?? ""} ${firstLine(textOf(commit.message) ?? "")}`
        })
        return textResult(limit([`Blame for ${args.path} at ${ref}:`, ...lines].join("\n")), {
          details: {
            repo: git.repo,
            path: args.path,
            ref,
            ranges: ranges.map((range) => ({
              start: range.start,
              end: range.end,
              commit: textOf(range.commit.oid) ?? null,
            })),
          },
        })
      } catch (error) {
        return toolFailure("git_blame", error)
      }
    },
  })

  return [log, show, diff, blame]
}
