import type { ConversationId } from "@earendil-works/pi-durable"
import type { ImageContent, TextContent } from "@earendil-works/pi-ai"
import type { MessageAttachment } from "../../src/contracts/message.ts"

export const INLINE_BUDGET_BYTES = 1024 * 1024

export type AttachmentPort = {
  readBytes(path: string): Promise<Uint8Array | undefined>
  stat(path: string): Promise<{ readonly size: number } | undefined>
  vision(conversation: ConversationId): Promise<boolean>
}

export type TurnContent = string | (TextContent | ImageContent)[]

type Present = { readonly file: MessageAttachment; readonly size: number }

function base64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ""
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

/** The files that exist, sized by storage rather than by what the client claimed. */
async function present(port: AttachmentPort, files: readonly MessageAttachment[]): Promise<Present[]> {
  const found = await Promise.all(files.map(async (file) => ({ file, entry: await port.stat(file.path) })))
  return found.flatMap(({ file, entry }) => (entry === undefined ? [] : [{ file, size: entry.size }]))
}

/**
 * One byte budget for the whole turn, so the stored entry stays far under a Durable Object row.
 *
 * The budget is spent against the size storage reports, before any bytes are read: an attachment
 * too large to fit is named in the list and never loaded into the isolate.
 */
async function images(port: AttachmentPort, conversation: ConversationId, files: readonly Present[]) {
  if (!(await port.vision(conversation))) return []
  const parts: ImageContent[] = []
  let budget = INLINE_BUDGET_BYTES
  for (const { file, size } of files) {
    if (!file.type.startsWith("image/") || size > budget) continue
    const bytes = await port.readBytes(file.path)
    if (bytes === undefined || bytes.byteLength > budget) continue
    budget -= bytes.byteLength
    parts.push({ type: "image", data: base64(bytes), mimeType: file.type })
  }
  return parts
}

export async function renderTurn(
  port: AttachmentPort,
  conversation: ConversationId,
  text: string,
  files: readonly MessageAttachment[],
): Promise<TurnContent> {
  if (files.length === 0) return text
  const found = await present(port, files)
  if (found.length === 0) return text
  const listed = found.map(({ file, size }) => `- ${file.name} (${file.type}, ${size} bytes) at ${file.path}`)
  return [
    { type: "text", text: `${text}\n\n<attachments>\n${listed.join("\n")}\n</attachments>` },
    ...(await images(port, conversation, found)),
  ]
}
