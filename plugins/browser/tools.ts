import type { Context } from "@earendil-works/chord"
import { defineTool, type Harness, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable"
import { compile, int, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema"
import type { JobRun, JobsService } from "../../src/contracts/jobs.ts"
import { messageOf } from "../../src/errors.ts"
import { textResult } from "../../src/kernel/index.ts"
import type { BrowserBackend, Machine } from "./backend.ts"
import type { Scope, Sessions } from "./session.ts"

const SNAPSHOT_CHARS = 8_000
const MAX_URL = 2_048
const MAX_TEXT = 10_000
const ERROR_CHARS = 2_000
const SCREENSHOT_PATH = "/data/tmp/ingle-browser.jpg"
const SCREENSHOT_TIMEOUT_MS = 90_000

const ACTIONS = [
  "click",
  "dblclick",
  "hover",
  "focus",
  "check",
  "uncheck",
  "scrollintoview",
  "fill",
  "type",
  "select",
  "press",
] as const

const OpenArgs = obj({
  url: str({ minLength: 1, maxLength: MAX_URL, description: "An http or https URL to load in the browser." }),
})

const SnapshotArgs = obj({
  offset: opt(int({ minimum: 0, description: "First character of the snapshot to return, 0 by default." })),
})

const ActArgs = obj({
  action: oneOf(ACTIONS, {
    description:
      "click, dblclick, hover, focus, check, uncheck or scrollintoview an element; fill (clear, then type), type or select (an option's value or label) with text; press a key such as Enter on the focused element.",
  }),
  ref: opt(str({ pattern: "^@?e[0-9]+$", description: "The element ref from the latest snapshot, such as e3." })),
  text: opt(str({ maxLength: MAX_TEXT, description: "The text for fill, type and select, or the key for press." })),
})

const EmptyArgs = obj({})

const openCheck = compile(OpenArgs)
const snapshotCheck = compile(SnapshotArgs)
const actCheck = compile(ActArgs)

type Act = Static<typeof ActArgs>

export type BrowserTools = {
  readonly jobs: JobsService
  readonly harness: Harness
  readonly backend: BrowserBackend
  readonly sessions: Sessions
}

function webUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("that is not a valid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are supported")
  return url.toString()
}

function actArgv(act: Act): readonly string[] | string {
  const ref = act.ref === undefined ? undefined : act.ref.startsWith("@") ? act.ref : `@${act.ref}`
  switch (act.action) {
    case "click":
    case "dblclick":
    case "hover":
    case "focus":
    case "check":
    case "uncheck":
    case "scrollintoview":
      return ref === undefined ? `${act.action} needs a ref from browser_snapshot` : [act.action, ref]
    case "fill":
    case "type":
    case "select":
      return ref === undefined || act.text === undefined
        ? `${act.action} needs a ref and text`
        : [act.action, ref, act.text]
    case "press":
      return act.text === undefined ? "press needs text: the key to press, such as Enter" : ["press", act.text]
    default: {
      const _exhaustive: never = act.action
      return _exhaustive
    }
  }
}

function snapshotWindow(text: string, offset: number): string {
  const total = text.length.toLocaleString("en-US")
  if (text === "") return "(the page has no accessible content)"
  if (offset >= text.length) return `[Offset ${offset} is past the end: the snapshot has ${total} characters.]`
  const end = offset + SNAPSHOT_CHARS
  const shown = text.slice(offset, end)
  if (end >= text.length) return shown
  return `${shown}\n\n[Showing characters ${offset}–${end} of ${total}. Call browser_snapshot with offset ${end} for more.]`
}

const failure = (action: string, error: unknown): ToolExecutionResult =>
  textResult(`${action} failed: ${messageOf(error)}`, { isError: true })

export function createTools(deps: BrowserTools): readonly ToolRegistration[] {
  const command = async (machine: Machine, argv: readonly string[], signal: AbortSignal): Promise<string> => {
    const result = await deps.backend.run(machine, ["agent-browser", ...argv], signal)
    if (result.exitCode === 0) return result.stdout.trim()
    throw new Error((result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).slice(-ERROR_CHARS))
  }

  const snapshot = (machine: Machine, signal: AbortSignal): Promise<string> =>
    command(machine, ["snapshot", "-c"], signal)

  const scopeOf = (run: JobRun, context: Context): Scope => ({
    docs: deps.harness,
    conversationId: run.conversationId,
    signal: run.signal,
    context,
  })

  const open = deps.jobs.tool(
    {
      name: "browser_open",
      description:
        "Open a URL in a headless Chromium browser that stays open for this conversation, and return the page's accessibility snapshot with element refs for browser_act.",
      parameters: OpenArgs,
      deferred: true,
    },
    async (args, run, context) => {
      if (!openCheck.check(args)) return textResult("browser_open needs a URL", { isError: true })
      try {
        const url = webUrl(args.url)
        const scope = scopeOf(run, context)
        const machine = await deps.sessions.open(scope)
        const opened = await command(machine, ["open", url], run.signal)
        const page = await snapshot(machine, run.signal)
        return textResult(`${opened}\n\n${snapshotWindow(page, 0)}`, { details: { url } })
      } catch (error) {
        return failure("browser_open", error)
      }
    },
  )

  const snapshotTool = deps.jobs.tool(
    {
      name: "browser_snapshot",
      description:
        "Read the open page's accessibility tree with element refs (e1, e2, ...), 8,000 characters at a time; page through a long one with offset.",
      parameters: SnapshotArgs,
      deferred: true,
    },
    async (args, run, context) => {
      if (!snapshotCheck.check(args)) return textResult("browser_snapshot takes an optional offset", { isError: true })
      try {
        const machine = await deps.sessions.current(scopeOf(run, context))
        return textResult(snapshotWindow(await snapshot(machine, run.signal), args.offset ?? 0))
      } catch (error) {
        return failure("browser_snapshot", error)
      }
    },
  )

  const act = deps.jobs.tool(
    {
      name: "browser_act",
      description:
        "Act on an element of the open page by its ref from the latest snapshot, then return the new snapshot.",
      parameters: ActArgs,
      deferred: true,
    },
    async (args, run, context) => {
      if (!actCheck.check(args)) return textResult("browser_act needs an action", { isError: true })
      const argv = actArgv(args)
      if (typeof argv === "string") return textResult(argv, { isError: true })
      try {
        const acting = await deps.sessions.act(scopeOf(run, context), run.jobId)
        if (acting.replayed) {
          const page = await snapshot(acting.machine, run.signal)
          return textResult(
            `The ${args.action} was cut off by a restart and may already have happened, so it was not repeated. Check the page before trying again.\n\n${snapshotWindow(page, 0)}`,
          )
        }
        const done = await command(acting.machine, argv, run.signal)
        const page = await snapshot(acting.machine, run.signal)
        return textResult(`${done === "" ? `${args.action} done` : done}\n\n${snapshotWindow(page, 0)}`)
      } catch (error) {
        return failure("browser_act", error)
      }
    },
  )

  const close = deps.jobs.tool(
    {
      name: "browser_close",
      description: "Close this conversation's browser and delete its machine. The next browser_open starts a new one.",
      parameters: EmptyArgs,
      deferred: true,
    },
    async (_args, run, context) => {
      try {
        const closed = await deps.sessions.close(scopeOf(run, context))
        return textResult(closed ? "Closed the browser." : "No browser was open.")
      } catch (error) {
        return failure("browser_close", error)
      }
    },
  )

  const screenshot = defineTool({
    name: "browser_screenshot",
    description: "Take a JPEG screenshot of the open page's viewport.",
    parameters: EmptyArgs,
    deferred: true,
    replay: "safe",
    execute: async (_args, api, context) => {
      const signal = AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS)
      try {
        const machine = await deps.sessions.current({ docs: api, conversationId: api.conversationId, signal, context })
        await command(
          machine,
          ["screenshot", "--screenshot-format", "jpeg", "--screenshot-quality", "70", SCREENSHOT_PATH],
          signal,
        )
        const encoded = await deps.backend.run(machine, ["base64", "-w0", SCREENSHOT_PATH], signal)
        if (encoded.exitCode !== 0) throw new Error(encoded.stderr.trim() || "the screenshot could not be read")
        return { output: [{ type: "image", data: encoded.stdout.trim(), mimeType: "image/jpeg" }] }
      } catch (error) {
        return failure("browser_screenshot", error)
      }
    },
  })

  return [open, snapshotTool, act, screenshot, close]
}
