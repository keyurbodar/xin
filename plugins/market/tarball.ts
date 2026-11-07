import type { BundleRow } from "../../src/kernel/index.ts"
import type { JsonValue } from "@earendil-works/chord"
import { obj, opt, str, unknown, compile } from "@earendil-works/pi-schema"
import { REQUEST_TIMEOUT_MS } from "./registry.ts"

export const MAX_TARBALL_BYTES = 8 * 1024 * 1024
export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024
export const MAX_FILE_BYTES = 64 * 1024

const BLOCK = 512
const PACKAGE_PREFIX = "package/"
const MANIFEST = "package.json"

export type ExtractedBundle = {
  readonly xin: unknown
  read(path: string): string | undefined
}

export type BundleFailure =
  | { readonly kind: "algorithm"; readonly message: string }
  | { readonly kind: "integrity"; readonly message: string }
  | { readonly kind: "gzip"; readonly message: string }
  | { readonly kind: "archive"; readonly message: string }
  | { readonly kind: "size"; readonly message: string }
  | { readonly kind: "manifest"; readonly message: string }
  | { readonly kind: "file"; readonly message: string }
  | { readonly kind: "redirect"; readonly message: string }
  | { readonly kind: "http"; readonly message: string }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }

export type BundleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BundleFailure }

export type ExtractInput = {
  readonly bytes: Uint8Array
  readonly integrity: string
  readonly cap?: number
}

export type FetchInput = {
  readonly timeoutMs?: number
  readonly cap?: number
}

export async function fetchTarball(
  fetchImpl: typeof fetch,
  url: string,
  options: FetchInput = {},
): Promise<BundleResult<Uint8Array>> {
  const cap = options.cap ?? MAX_TARBALL_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { redirect: "manual", signal: controller.signal })
    if (response.status >= 300 && response.status < 400)
      return { ok: false, error: { kind: "redirect", message: `GET ${url}: redirect refused` } }
    if (!response.ok) return { ok: false, error: { kind: "http", message: `GET ${url}: HTTP ${response.status}` } }
    const declared = response.headers.get("content-length")
    if (declared !== null && Number(declared) > cap)
      return { ok: false, error: { kind: "size", message: `tarball exceeds ${cap} bytes` } }
    return await readCapped(response, cap)
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: { kind: "timeout", message: "request timed out" } }
    return { ok: false, error: { kind: "network", message: messageOf(error) } }
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(response: Response, cap: number): Promise<BundleResult<Uint8Array>> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > cap
      ? { ok: false, error: { kind: "size", message: `tarball exceeds ${cap} bytes` } }
      : { ok: true, value: bytes }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      return { ok: false, error: { kind: "size", message: `tarball exceeds ${cap} bytes` } }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, value: bytes }
}

const ManifestSchema = obj(
  { name: opt(str({ minLength: 1 })), version: opt(str({ minLength: 1 })), xin: opt(unknown()) },
  { open: true },
)
const manifestCheck = compile(ManifestSchema)

export async function extractBundle(input: ExtractInput): Promise<BundleResult<ExtractedBundle>> {
  const verified = await verifyIntegrity(input.bytes, input.integrity)
  if (!verified.ok) return verified
  const unpacked = await gunzip(input.bytes, input.cap ?? MAX_UNPACKED_BYTES)
  if (!unpacked.ok) return unpacked
  const entries = parseUstar(unpacked.value)
  if (!entries.ok) return entries
  const files = new Map<string, Uint8Array>()
  for (const entry of entries.value) {
    if (files.has(entry.path))
      return { ok: false, error: { kind: "archive", message: `tarball repeats ${entry.path}` } }
    files.set(entry.path, entry.bytes)
  }
  const manifest = files.get(MANIFEST)
  if (manifest === undefined) {
    return { ok: false, error: { kind: "manifest", message: `tarball has no ${PACKAGE_PREFIX}${MANIFEST}` } }
  }
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(manifest))
  } catch (error) {
    return { ok: false, error: { kind: "manifest", message: `${MANIFEST}: ${messageOf(error)}` } }
  }
  if (!manifestCheck.check(document)) {
    const errors = manifestCheck.errors(document)
    const first = errors[0]
    const detail = first === undefined ? `${MANIFEST} is invalid` : `${MANIFEST}${first.path}: ${first.message}`
    return { ok: false, error: { kind: "manifest", message: detail } }
  }
  const texts = new Map<string, string>()
  return {
    ok: true,
    value: {
      xin: document.xin,
      read(path) {
        if (!safeRelativePath(path)) return undefined
        const cached = texts.get(path)
        if (cached !== undefined) return cached
        const bytes = files.get(path)
        if (bytes === undefined) return undefined
        const text = new TextDecoder().decode(bytes)
        texts.set(path, text)
        return text
      },
    },
  }
}

export function inlineFiles(
  rows: readonly BundleRow[],
  read: (path: string) => string | undefined,
): BundleResult<readonly BundleRow[]> {
  const inlined: BundleRow[] = []
  for (const row of rows) {
    if (row.config === undefined) {
      inlined.push(row)
      continue
    }
    const config = inlineValue(row.config, read)
    if (!config.ok) return config
    inlined.push({ ...row, config: config.value })
  }
  return { ok: true, value: inlined }
}

export function safeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false
  return !path.split("/").includes("..")
}

export function tarballAllowed(tarballUrl: string, registryUrl: string): boolean {
  try {
    const tarball = new URL(tarballUrl)
    const registry = new URL(registryUrl)
    return tarball.protocol === "https:" && tarball.host === registry.host
  } catch {
    return false
  }
}

type Inline = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly error: BundleFailure }

function inlineValue(value: JsonValue, read: (path: string) => string | undefined): Inline {
  const path = fileReference(value)
  if (path !== undefined) return readFile(path, read)
  if (Array.isArray(value)) {
    const items: JsonValue[] = []
    for (const item of value) {
      const inlined = inlineValue(item, read)
      if (!inlined.ok) return inlined
      items.push(inlined.value)
    }
    return { ok: true, value: items }
  }
  if (isRecord(value)) {
    const record: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const inlined = inlineValue(item, read)
      if (!inlined.ok) return inlined
      record[key] = inlined.value
    }
    return { ok: true, value: record }
  }
  return { ok: true, value }
}

function readFile(path: string, read: (path: string) => string | undefined): Inline {
  if (!safeRelativePath(path)) return { ok: false, error: { kind: "file", message: `unsafe file path ${path}` } }
  const text = read(path)
  if (text === undefined) return { ok: false, error: { kind: "file", message: `missing file ${path}` } }
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES)
    return { ok: false, error: { kind: "size", message: `file ${path} exceeds ${MAX_FILE_BYTES} bytes` } }
  return { ok: true, value: text }
}

function fileReference(value: JsonValue): string | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== "$file") return undefined
  const path = value["$file"]
  return typeof path === "string" ? path : undefined
}

async function verifyIntegrity(bytes: Uint8Array, integrity: string): Promise<BundleResult<Uint8Array>> {
  const dash = integrity.indexOf("-")
  const algorithm = dash === -1 ? integrity : integrity.slice(0, dash)
  const encoded = dash === -1 ? "" : integrity.slice(dash + 1)
  if (algorithm !== "sha512" || encoded === "") {
    return { ok: false, error: { kind: "algorithm", message: `unsupported integrity ${integrity}` } }
  }
  let expected: Uint8Array
  try {
    expected = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  } catch {
    return { ok: false, error: { kind: "integrity", message: `invalid base64 in ${integrity}` } }
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes))
  if (digest.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(digest, expected))
    return { ok: false, error: { kind: "integrity", message: "tarball does not match dist.integrity" } }
  return { ok: true, value: bytes }
}

async function gunzip(bytes: Uint8Array, cap: number): Promise<BundleResult<Uint8Array>> {
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader()
  } catch (error) {
    return { ok: false, error: { kind: "gzip", message: messageOf(error) } }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        await reader.cancel()
        return { ok: false, error: { kind: "size", message: `unpacked tarball exceeds ${cap} bytes` } }
      }
      chunks.push(value)
    }
  } catch (error) {
    return { ok: false, error: { kind: "gzip", message: messageOf(error) } }
  }
  const unpacked = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    unpacked.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, value: unpacked }
}

type TarEntry = { readonly path: string; readonly bytes: Uint8Array }

function parseUstar(archive: Uint8Array): BundleResult<readonly TarEntry[]> {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK)
    if (isZero(header)) break
    const size = octal(header, 124, 12)
    if (size === undefined) {
      return { ok: false, error: { kind: "archive", message: "tarball header has an invalid size" } }
    }
    const type = String.fromCharCode(header[156] ?? 0)
    const name = cstring(header, 0, 100)
    const prefix = cstring(header, 345, 155)
    const next = offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (next > archive.byteLength) return { ok: false, error: { kind: "archive", message: "tarball is truncated" } }
    if (type === "0" || type === "\0") {
      const full = prefix === "" ? name : `${prefix}/${name}`
      if (full.startsWith(PACKAGE_PREFIX)) {
        const path = full.slice(PACKAGE_PREFIX.length)
        const bytes = archive.subarray(offset + BLOCK, offset + BLOCK + size)
        if (safeRelativePath(path)) entries.push({ path, bytes })
      }
    }
    offset = next
  }
  return { ok: true, value: entries }
}

function cstring(header: Uint8Array, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && header[end] !== 0) end += 1
  return new TextDecoder().decode(header.subarray(offset, end))
}

function octal(header: Uint8Array, offset: number, length: number): number | undefined {
  const text = cstring(header, offset, length).trim()
  if (text === "") return 0
  if (!/^[0-7]+$/.test(text)) return undefined
  return Number.parseInt(text, 8)
}

function isZero(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
