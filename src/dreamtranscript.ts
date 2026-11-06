import type { Context } from "@earendil-works/chord"
import type {
  Conversation,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  TaskId,
} from "@earendil-works/pi-durable"
import { messageText } from "./transcript.ts"

const TRANSCRIPT_TOKENS = 24_000
const TRANSCRIPT_CHARS = TRANSCRIPT_TOKENS * 4
const TRANSCRIPT_PAGE = 100
const CONVERSATION_PAGE = 100

export type TranscriptChunk = { readonly text: string; readonly end: number }

type Feed = { next(): Promise<EntryRecord | undefined> }

type Slot = { readonly feed: Feed; head: EntryRecord | undefined }

export async function readTranscript(
  harness: Harness,
  taskId: TaskId,
  after: number,
  ctx: Context,
  taskKind: string,
): Promise<TranscriptChunk> {
  const slots: Slot[] = []
  for (const feed of await transcriptFeeds(harness, taskId, after, ctx, taskKind))
    slots.push({ feed, head: await feed.next() })
  const lines: string[] = []
  let chars = 0
  let end = after
  while (true) {
    const slot = oldestHead(slots)
    const entry = slot?.head
    if (slot === undefined || entry === undefined) break
    const text = transcriptEntry(entry)
    if (text === undefined) {
      end = entry.id
    } else {
      const room = TRANSCRIPT_CHARS - chars
      if (text.length + 1 <= room) {
        lines.push(text)
        chars += text.length + 1
        end = entry.id
      } else if (lines.length === 0) {
        lines.push(`${text.slice(0, room)}…`)
        end = entry.id
        break
      } else {
        break
      }
    }
    slot.head = await slot.feed.next()
  }
  return { text: lines.join("\n"), end }
}

function oldestHead(slots: readonly Slot[]): Slot | undefined {
  let best: Slot | undefined
  for (const slot of slots) {
    const head = slot.head
    if (head === undefined) continue
    const current = best?.head
    if (current === undefined || head.id < current.id) best = slot
  }
  return best
}

async function transcriptFeeds(
  harness: Harness,
  taskId: TaskId,
  after: number,
  ctx: Context,
  taskKind: string,
): Promise<readonly Feed[]> {
  const records = await harness.commit(async (tx) => {
    const found: ConversationRecord[] = []
    let cursor: Cursor | undefined
    while (true) {
      const page = await tx.scanConversations({ order: "ascending" }, CONVERSATION_PAGE, cursor)
      found.push(...page.items)
      if (page.next === undefined) return found
      cursor = page.next
    }
  }, ctx)
  const feeds: Feed[] = []
  for (const record of records) {
    if (await ownedByTask(harness, record, taskId, ctx, taskKind)) continue
    const conversation = await harness.conversation(record.id, ctx)
    if (conversation !== undefined) feeds.push(transcriptFeed(conversation, after, ctx))
  }
  return feeds
}

async function ownedByTask(
  harness: Harness,
  record: ConversationRecord,
  taskId: TaskId,
  ctx: Context,
  taskKind: string,
): Promise<boolean> {
  const owner = record.owner
  if (owner === undefined) return false
  if (owner.taskId === taskId) return true
  const task = await harness.getTask(owner.taskId, ctx)
  return task?.kind === taskKind
}

function transcriptFeed(conversation: Conversation, after: number, ctx: Context): Feed {
  let cursor: Cursor | undefined
  let done = false
  let buffered: readonly EntryRecord[] = []
  return {
    next: async () => {
      while (true) {
        const [entry, ...rest] = buffered
        if (entry !== undefined) {
          buffered = rest
          return entry
        }
        if (done) return undefined
        const page = await conversation.entries(
          { order: "ascending", minEntryId: (after + 1) as EntryId },
          TRANSCRIPT_PAGE,
          cursor,
          ctx,
        )
        buffered = page.items
        cursor = page.next
        done = page.next === undefined
      }
    },
  }
}

function transcriptEntry(entry: EntryRecord): string | undefined {
  if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return undefined
  const lines: string[] = []
  for (const message of entry.model ?? []) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const text = messageText(message).trim()
    if (text.length > 0) lines.push(`${message.role}: ${text}`)
  }
  return lines.length === 0 ? undefined : lines.join("\n")
}
