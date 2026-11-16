import type { Context } from "@earendil-works/chord"
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env"
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema"
import { textResult } from "../../src/kernel/index.ts"

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1_000
const MAX_OUTPUT_CHARS = 8_000
/** A walk visits at most this many entries, so a huge tree costs a bounded number of index rows. */
const MAX_VISITED = 5_000
const GREP_MAX_FILES = 200
const GREP_MAX_FILE_BYTES = 512 * 1024
const GREP_MAX_BYTES = 4 * 1024 * 1024
const MATCH_PREVIEW_CHARS = 200
const VISIT_NOTE = `[Stopped after ${MAX_VISITED} entries: start from a deeper path.]`

const PathArg = opt(str({ description: "Directory; the working directory by default." }))
const LimitArg = opt(int({ minimum: 1, maximum: MAX_LIMIT, description: `Default ${DEFAULT_LIMIT}.` }))

const failure = (text: string): ToolExecutionResult => textResult(text, { isError: true })

const envOf = (api: ToolExecutionApi): ExecutionEnv => {
  if (api.env === undefined) throw new Error("No execution environment is configured")
  return api.env
}

/** Lines up to the output cap, then the notes, so a long listing never fills the context. */
const capped = (lines: readonly string[], notes: readonly string[]): string => {
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > MAX_OUTPUT_CHARS) break
    kept.push(line)
    size += line.length + 1
  }
  const cut = lines.length - kept.length
  return [...kept, ...(cut > 0 ? [`[${cut} more not shown: narrow the path or pattern.]`] : []), ...notes].join("\n")
}

/** `*` and `?` stay inside one path segment and `**` spans any number; a pattern without `/` matches the file name. */
export function globMatcher(pattern: string): (relative: string) => boolean {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index)
    if (char === "*" && pattern.charAt(index + 1) === "*") {
      const slash = pattern.charAt(index + 2) === "/"
      source += slash ? "(?:.*/)?" : ".*"
      index += slash ? 2 : 1
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[|\\{}()[\]^$+.]/g, String.raw`\$&`)
  }
  const regex = new RegExp(`^${source}$`)
  const byName = !pattern.includes("/")
  return (relative) => regex.test(byName ? relative.slice(relative.lastIndexOf("/") + 1) : relative)
}

type Walk = { readonly files: readonly FileInfo[]; readonly cut: boolean }

/** Every file under `root`, breadth first, stopping after `MAX_VISITED` entries. */
async function walk(env: ExecutionEnv, root: string, context: Context): Promise<Walk> {
  const files: FileInfo[] = []
  const queue = [root]
  let visited = 0
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    const listed = await env.listDir(dir, context)
    if (!listed.ok) continue
    for (const entry of listed.value) {
      visited += 1
      if (visited > MAX_VISITED) return { files, cut: true }
      if (entry.kind === "directory") queue.push(entry.path)
      else if (entry.kind === "file") files.push(entry)
    }
  }
  return { files, cut: false }
}

const relativeTo = (root: string, path: string): string => {
  const prefix = root === "/" ? "/" : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const byPath = (left: FileInfo, right: FileInfo): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0

/** The directory a call starts from, or the error result to return. */
async function rootOf(
  env: ExecutionEnv,
  path: string | undefined,
  context: Context,
): Promise<string | ToolExecutionResult> {
  const resolved = await env.absolutePath(path ?? ".", context)
  if (!resolved.ok) return failure(resolved.error.message)
  const info = await env.fileInfo(resolved.value, context)
  if (!info.ok) return failure(info.error.message)
  if (info.value.kind !== "directory") return failure(`${resolved.value} is not a directory`)
  return resolved.value
}

const lsTool = defineTool({
  name: "ls",
  description: "List a directory (subdirectories end with /, files show bytes).",
  parameters: obj({ path: PathArg, limit: LimitArg }),
  replay: "safe",
  execute: async (args, api, context) => {
    const env = envOf(api)
    const root = await rootOf(env, args.path, context)
    if (typeof root !== "string") return root
    const listed = await env.listDir(root, context)
    if (!listed.ok) return failure(listed.error.message)
    if (listed.value.length === 0) return textResult(`${root} is empty.`)
    const limit = args.limit ?? DEFAULT_LIMIT
    const lines = listed.value
      .slice(0, limit)
      .map((entry) => (entry.kind === "directory" ? `${entry.name}/` : `${entry.name}  ${entry.size}`))
    const notes = listed.value.length > limit ? [`[${listed.value.length - limit} more: raise limit.]`] : []
    return textResult(capped(lines, notes), { details: { path: root, entries: listed.value.length } })
  },
})

const findTool = defineTool({
  name: "find",
  description: "Find files under a directory by glob, such as **/*.ts; a pattern without / matches names.",
  parameters: obj({
    pattern: str({ minLength: 1, maxLength: 500 }),
    path: PathArg,
    limit: LimitArg,
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const env = envOf(api)
    const root = await rootOf(env, args.path, context)
    if (typeof root !== "string") return root
    const walked = await walk(env, root, context)
    const matches = globMatcher(args.pattern)
    const found = walked.files
      .map((file) => relativeTo(root, file.path))
      .filter(matches)
      .toSorted()
    const visitNote = walked.cut ? [VISIT_NOTE] : []
    if (found.length === 0)
      return textResult([`No files under ${root} match ${args.pattern}.`, ...visitNote].join("\n"))
    const limit = args.limit ?? DEFAULT_LIMIT
    const notes = [
      ...(found.length > limit ? [`[${found.length - limit} more: raise limit or narrow the pattern.]`] : []),
      ...visitNote,
    ]
    return textResult(capped(found.slice(0, limit), notes), { details: { path: root, matches: found.length } })
  },
})

const grepTool = defineTool({
  name: "grep",
  description: "Search text files under a directory for a regular expression; answers path:line: text.",
  parameters: obj({
    pattern: str({ minLength: 1, maxLength: 500 }),
    path: PathArg,
    glob: opt(str({ minLength: 1, maxLength: 500, description: "Only files matching this glob." })),
    ignoreCase: opt(bool()),
    limit: LimitArg,
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    let regex: RegExp
    try {
      regex = new RegExp(args.pattern, args.ignoreCase === true ? "i" : "")
    } catch (error) {
      return failure(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
    }
    const env = envOf(api)
    const root = await rootOf(env, args.path, context)
    if (typeof root !== "string") return root
    const walked = await walk(env, root, context)
    const wanted = args.glob === undefined ? () => true : globMatcher(args.glob)
    const candidates = walked.files
      .filter((file) => file.size <= GREP_MAX_FILE_BYTES && wanted(relativeTo(root, file.path)))
      .toSorted(byPath)
    const limit = args.limit ?? DEFAULT_LIMIT
    const lines: string[] = []
    let scanned = 0
    let bytes = 0
    let stopped = false
    for (const file of candidates) {
      if (lines.length >= limit || scanned >= GREP_MAX_FILES || bytes + file.size > GREP_MAX_BYTES) {
        stopped = true
        break
      }
      scanned += 1
      bytes += file.size
      const text = await env.readTextFile(file.path, context)
      if (!text.ok || text.value.includes("\u0000")) continue
      for (const [index, line] of text.value.split(/\r?\n/).entries()) {
        if (!regex.test(line)) continue
        if (lines.length >= limit) {
          stopped = true
          break
        }
        const preview = line.length <= MATCH_PREVIEW_CHARS ? line : `${line.slice(0, MATCH_PREVIEW_CHARS)}…`
        lines.push(`${relativeTo(root, file.path)}:${index + 1}: ${preview}`)
      }
    }
    const notes = [
      ...(stopped
        ? [`[Stopped after ${lines.length} matches in ${scanned} files: narrow the path, glob or pattern.]`]
        : []),
      ...(walked.cut ? [VISIT_NOTE] : []),
    ]
    if (lines.length === 0) return textResult([`No matches in ${scanned} files under ${root}.`, ...notes].join("\n"))
    return textResult(capped(lines, notes), { details: { path: root, matches: lines.length, scanned } })
  },
})

export const DISCOVERY_TOOLS: readonly ToolRegistration[] = [lsTool, findTool, grepTool]
