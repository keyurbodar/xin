import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"
import {
  defineTask,
  type Cursor,
  type Task,
  type TaskId,
  type TaskRecord,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable"
import type { NoteDraft } from "../../src/contracts/memory.ts"
import { resolveModel } from "../../src/contracts/models.ts"
import type { ModuleDeps } from "../../src/module.ts"
import { liveSecrets } from "./dreamersecrets.ts"
import { SYSTEM_PROMPT, validateDreamerOutput, type DreamerOutput } from "./dreamprompt.ts"
import { readTranscript } from "./dreamtranscript.ts"

const context = BACKGROUND_CONTEXT

export const DREAMER_TASK = "xin.dreamer"
export const IDLE_MS = 10 * 60_000
export const RETRY_MS = 10 * 60_000
export const PROFILE_KEY = "profile_md"
export const CURSOR_KEY = "dreamer_cursor"
export const TRANSCRIPT_CURSOR_KEY = "dreamer_transcript_cursor"
export const DUE_KEY = "dreamer_due"
export const RETRY_KEY = "dreamer_retry_at"

const DAILY_HOUR = 3
const DAY_MS = 24 * 60 * 60_000
const NOTES_LIMIT = 200
const NOTES_BUDGET = 12_000
const TASKS_PAGE = 100
const ATTEMPTS = 2
const MAX_TOKENS = 2048

type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>

export type NoteRow = {
  readonly id: number
  readonly scope: string
  readonly text: string
  readonly at: number
}

export async function appendNote(db: SqliteExecutor, note: NoteDraft): Promise<boolean> {
  const inserted = await db.runCounted(
    "INSERT OR IGNORE INTO notes (scope, text, source, origin_task, at) VALUES (?, ?, ?, ?, ?)",
    note.scope,
    note.text,
    note.source,
    note.originTask,
    note.at,
  )
  return inserted > 0
}

export async function readKv(db: SqliteExecutor, key: string): Promise<string | undefined> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)
  return row?.value
}

export function writeKv(db: SqliteExecutor, key: string, value: string): Promise<void> {
  return db.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    value,
  )
}

export function deleteKv(db: SqliteExecutor, key: string): Promise<void> {
  return db.run("DELETE FROM kv WHERE key = ?", key)
}

export async function readNumber(db: SqliteExecutor, key: string): Promise<number | undefined> {
  const raw = await readKv(db, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export async function readProfile(db: SqliteExecutor): Promise<string> {
  return (await readKv(db, PROFILE_KEY)) ?? ""
}

export async function requestPass(deps: ModuleDeps<"models">, at: number): Promise<void> {
  const existing = await readNumber(deps.db, DUE_KEY)
  const due = existing === undefined ? at : Math.min(existing, at)
  await writeKv(deps.db, DUE_KEY, String(due))
  await ensurePass(deps, due)
  await deps.arm()
}

export async function ensurePass(deps: ModuleDeps<"models">, at: number): Promise<void> {
  const harness = deps.harness()
  const root = await harness.root(context)
  const stale = await harness.commit(async (tx) => {
    const live = await liveDreamers(tx)
    if (live.some((task) => dueAt(task, at))) return undefined
    await tx.createTask(
      dreamerTask(deps),
      { at },
      { ownership: { kind: "conversation" }, conversationId: root.id, background: true },
    )
    return live.map((task) => task.id)
  }, context)
  for (const id of stale ?? []) await harness.abortTask(id, context)
}

async function liveDreamers(tx: Tx): Promise<readonly AnyTask[]> {
  const found: AnyTask[] = []
  let cursor: Cursor | undefined
  while (true) {
    const page = await tx.scanTasks({ kind: DREAMER_TASK, abortRequested: false }, TASKS_PAGE, cursor)
    for (const task of page.items)
      if (task.state.status !== "terminal" && task.state.status !== "completing") found.push(task)
    if (page.next === undefined) return found
    cursor = page.next
  }
}

const dueAt = (task: AnyTask, at: number): boolean => task.state.status !== "sleeping" || task.state.until <= at

type DreamerInput = { readonly at: number }
type DreamerState = { readonly phase: "wake" } | { readonly phase: "wait" } | { readonly phase: "pass" }

export function dreamerTask(deps: ModuleDeps<"models">): Task<DreamerInput, DreamerState, null, object> {
  return defineTask<DreamerInput, DreamerState, null, object>({
    name: DREAMER_TASK,
    version: 1,
    initial: (): DreamerState => ({ phase: "wake" }),
    phases: {
      wake: async (task, runtime, ctx) => {
        const now = runtime.now()
        const retry = (await readNumber(deps.db, RETRY_KEY)) ?? 0
        const at = Math.max(task.input.at, retry)
        if (at > now) return runtime.sleepUntil(at, { phase: "pass" }, ctx)
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "pass" } }), ctx)
      },
      wait: async (_task, runtime, ctx) => {
        const now = runtime.now()
        const next = await nextPass(deps, now)
        if (next > now) return runtime.sleepUntil(next, { phase: "wait" }, ctx)
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "pass" } }), ctx)
      },
      pass: async (task, runtime, ctx) => {
        await runPass(deps, task.id, runtime, ctx)
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), ctx)
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  })
}

async function nextPass(deps: ModuleDeps<"models">, now: number): Promise<number> {
  const retry = await readNumber(deps.db, RETRY_KEY)
  if (retry !== undefined && retry > now) return retry
  const due = await readNumber(deps.db, DUE_KEY)
  const cursor = (await readNumber(deps.db, CURSOR_KEY)) ?? 0
  const newest = await deps.db.get<{ at: number }>(
    "SELECT at FROM notes WHERE id > ? AND retired_by IS NULL AND source != 'dreamer' ORDER BY at DESC LIMIT 1",
    cursor,
  )
  return Math.min(
    daily(now),
    ...(due === undefined ? [] : [due]),
    ...(newest === undefined ? [] : [newest.at + IDLE_MS]),
  )
}

function daily(now: number): number {
  const day = new Date(now)
  const today = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAILY_HOUR).getTime()
  return today > now ? today : today + DAY_MS
}

async function runPass(
  deps: ModuleDeps<"models">,
  taskId: TaskId,
  runtime: TaskRuntime<DreamerInput, DreamerState, null, object>,
  ctx: Context,
): Promise<void> {
  const requested = await readKv(deps.db, DUE_KEY)
  const cursor = (await readNumber(deps.db, CURSOR_KEY)) ?? 0
  const notes = await deps.db.all<NoteRow>(
    "SELECT id, scope, text, at FROM notes WHERE id > ? AND retired_by IS NULL ORDER BY id ASC LIMIT ?",
    cursor,
    NOTES_LIMIT,
  )
  const included = withinBudget(notes)
  const end = included.at(-1)?.id ?? cursor
  const transcriptCursor = (await readNumber(deps.db, TRANSCRIPT_CURSOR_KEY)) ?? 0
  const transcripts = await readTranscript(deps.harness(), taskId, transcriptCursor, ctx, DREAMER_TASK)
  const model = await chooseModel(deps, runtime, ctx)
  const output = model === undefined ? undefined : await draft(deps, runtime, ctx, model, included, transcripts.text)
  if (output === undefined) {
    await writeKv(deps.db, RETRY_KEY, String(runtime.now() + RETRY_MS))
    return
  }
  await apply(deps.db, taskId, output, end, transcripts.end, requested)
}

function withinBudget(notes: readonly NoteRow[]): readonly NoteRow[] {
  const included: NoteRow[] = []
  let chars = 0
  for (const note of notes) {
    const size = noteLine(note).length + 1
    if (included.length > 0 && chars + size > NOTES_BUDGET) break
    included.push(note)
    chars += size
  }
  return included
}

const noteLine = (note: NoteRow): string =>
  `${note.id} (${note.scope}, ${new Date(note.at).toISOString()}): ${note.text}`

async function draft(
  deps: ModuleDeps<"models">,
  runtime: TaskRuntime<DreamerInput, DreamerState, null, object>,
  ctx: Context,
  model: Model<Api>,
  notes: readonly NoteRow[],
  transcripts: string,
): Promise<DreamerOutput | undefined> {
  const prompt = renderPrompt(await readProfile(deps.db), notes, transcripts)
  const shown = new Set(notes.map((note) => note.id))
  const secrets = await liveSecrets(deps)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const answer = await complete(runtime, model, prompt)
    if (answer === undefined) return undefined
    const output = validateDreamerOutput(parseJson(textOf(answer)), shown, secrets)
    if (output !== undefined) return output
  }
  return undefined
}

async function complete(
  runtime: TaskRuntime<DreamerInput, DreamerState, null, object>,
  model: Model<Api>,
  prompt: string,
): Promise<AssistantMessage | undefined> {
  try {
    const answer = await runtime.models.completeSimple(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { signal: runtime.signal, maxTokens: MAX_TOKENS },
    )
    return answer.stopReason === "error" ? undefined : answer
  } catch {
    return undefined
  }
}

function textOf(answer: AssistantMessage): string {
  return answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function renderPrompt(profile: string, notes: readonly NoteRow[], transcripts: string): string {
  const sections = [`<profile>\n${profile}\n</profile>`, `<notes>\n${notes.map(noteLine).join("\n")}\n</notes>`]
  if (transcripts.length > 0) sections.push(`<transcripts>\n${transcripts}\n</transcripts>`)
  return sections.join("\n")
}

async function apply(
  db: SqliteDatabase,
  taskId: TaskId,
  output: DreamerOutput,
  end: number,
  transcriptEnd: number,
  requested: string | undefined,
): Promise<void> {
  const now = Date.now()
  await db.transaction(async (tx) => {
    for (const note of output.add)
      await appendNote(tx, {
        text: note.text,
        scope: note.scope,
        source: "dreamer",
        originTask: `dreamer:${taskId}`,
        at: now,
      })
    for (const id of output.retire)
      await tx.run("UPDATE notes SET retired_by = ? WHERE id = ? AND retired_by IS NULL", taskId, id)
    await writeKv(tx, PROFILE_KEY, output.profile_md)
    await writeKv(tx, CURSOR_KEY, String(end))
    await writeKv(tx, TRANSCRIPT_CURSOR_KEY, String(transcriptEnd))
    if (requested !== undefined) await tx.run("DELETE FROM kv WHERE key = ? AND value = ?", DUE_KEY, requested)
    await deleteKv(tx, RETRY_KEY)
  })
}

async function chooseModel(
  deps: ModuleDeps<"models">,
  runtime: TaskRuntime<DreamerInput, DreamerState, null, object>,
  ctx: Context,
): Promise<Model<Api> | undefined> {
  const resolved = resolveModel({ role: "utility", owner: await deps.services.models.ownerDefaults() })
  const ref = resolved.kind === "model" ? resolved.model : (await runtime.agent(ctx)).model
  if (ref === undefined) return undefined
  return runtime.models.getModel(ref.provider, ref.modelId)
}
