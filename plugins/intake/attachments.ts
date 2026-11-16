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

const plain = (value: string): string =>
  value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

const attribute = (value: string): string => plain(value).replaceAll('"', "&quot;")

/** A file's own `<file` or `</attachments` tags would forge the markup around it, so only those are escaped. */
const fenced = (text: string): string => text.replace(/<(\/?(?:file|attachments)\b)/giu, "&lt;$1")

const SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "image/png": (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/gif": (bytes) => new TextDecoder().decode(bytes.subarray(0, 4)) === "GIF8",
  "image/webp": (bytes) =>
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP",
}

const isImage = (type: string, bytes: Uint8Array): boolean => SIGNATURES[type]?.(bytes) === true

/**
 * One user message for a turn's files. Every file is listed; an image goes to a vision model as an image part and a
 * text file is inlined, each within its own budget for the whole turn.
 *
 * Budgets are spent against the size the message recorded from the files index, before any bytes are read, so a file
 * that does not fit is named and never loaded into the isolate. Bytes are read by content address, so a replay after a
 * crash renders the same turn even when the path has been overwritten since. An item queued before blobs were recorded
 * is listed by path alone. Names, types and paths are escaped and an inlined file cannot close its wrapper, so a crafted
 * file cannot forge the markup around it; an image whose bytes do not match its type is never sent as one.
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
    const size = file.size === undefined ? "" : `, ${file.size} bytes`
    const line = `- ${plain(file.name)} (${plain(file.type)}${size}) at ${plain(file.path)}`
    if (file.sha256 === undefined || file.size === undefined) {
      listed.push(line)
      continue
    }
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
      if (!isImage(file.type, bytes)) {
        listed.push(`${line}: not shown, its bytes are not ${file.type}`)
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
      inlined.push(`<file path="${attribute(file.path)}">\n${fenced(new TextDecoder().decode(bytes))}\n</file>`)
      listed.push(`${line}: inlined below`)
      continue
    }
    listed.push(line)
  }
  const block = [`<attachments>\n${listed.join("\n")}\n</attachments>`, ...inlined].join("\n")
  return [{ type: "text", text: `${text}\n\n${block}` }, ...images]
}
