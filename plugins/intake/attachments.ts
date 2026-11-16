import type { ConversationId } from "@earendil-works/pi-durable"
import type { ImageContent, TextContent } from "@earendil-works/pi-ai"
import { isText } from "../../src/contracts/files.ts"
import type { MessageAttachment } from "../../src/contracts/message.ts"

export const IMAGE_BUDGET_BYTES = 1024 * 1024
export const TEXT_BUDGET_BYTES = 64 * 1024

const IMAGE_PART = /^image\/(png|jpeg|gif|webp)$/

export type AttachmentPort = {
  readBlob(sha256: string): Promise<Uint8Array | undefined>
  vision(conversation: ConversationId): Promise<boolean>
}

export type TurnContent = string | (TextContent | ImageContent)[]

function base64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ""
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

const attribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")

/**
 * One user message for a turn's files. Every file is listed; an image goes to a vision model as an image part and a
 * text file is inlined, each within its own budget for the whole turn.
 *
 * Budgets are spent against the size the message recorded from the files index, before any bytes are read, so a file
 * that does not fit is named and never loaded into the isolate. Bytes are read by content address, so a replay after a
 * crash renders the same turn even when the path has been overwritten since.
 */
export async function renderTurn(
  port: AttachmentPort,
  conversation: ConversationId,
  text: string,
  files: readonly MessageAttachment[],
): Promise<TurnContent> {
  if (files.length === 0) return text
  const sees = files.some((file) => IMAGE_PART.test(file.type)) && (await port.vision(conversation))
  let imageBudget = IMAGE_BUDGET_BYTES
  let textBudget = TEXT_BUDGET_BYTES
  const listed: string[] = []
  const inlined: string[] = []
  const images: ImageContent[] = []
  for (const file of files) {
    const line = `- ${file.name} (${file.type}, ${file.size} bytes) at ${file.path}`
    if (IMAGE_PART.test(file.type)) {
      if (!sees) {
        listed.push(`${line}: not shown, this model does not take images`)
        continue
      }
      if (file.size > imageBudget) {
        listed.push(`${line}: not shown, over this turn's ${IMAGE_BUDGET_BYTES / 1024} KiB image budget`)
        continue
      }
      const bytes = await port.readBlob(file.sha256)
      if (bytes === undefined) {
        listed.push(`${line}: no longer stored`)
        continue
      }
      imageBudget -= bytes.byteLength
      images.push({ type: "image", data: base64(bytes), mimeType: file.type })
      listed.push(`${line}: shown below`)
      continue
    }
    if (isText(file.type)) {
      if (file.size > textBudget) {
        listed.push(`${line}: not inlined, over this turn's ${TEXT_BUDGET_BYTES / 1024} KiB text budget`)
        continue
      }
      const bytes = await port.readBlob(file.sha256)
      if (bytes === undefined) {
        listed.push(`${line}: no longer stored`)
        continue
      }
      textBudget -= bytes.byteLength
      inlined.push(`<file path="${attribute(file.path)}">\n${new TextDecoder().decode(bytes)}\n</file>`)
      listed.push(`${line}: inlined below`)
      continue
    }
    listed.push(line)
  }
  const block = [`<attachments>\n${listed.join("\n")}\n</attachments>`, ...inlined].join("\n")
  return [{ type: "text", text: `${text}\n\n${block}` }, ...images]
}
