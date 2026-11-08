import { compile, obj, opt, unknown } from "@earendil-works/pi-schema"
import { messageOf } from "../../src/errors.ts"
import { REQUEST_TIMEOUT_MS } from "./registry.ts"

export const MAX_TARBALL_BYTES = 8 * 1024 * 1024
export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024

const BLOCK = 512
const PACKAGE_PREFIX = "package/"
const MANIFEST = "package.json"

export type ExtractedBundle = { readonly xin: unknown }

export type BundleFailure =
  | { readonly kind: "input"; readonly message: string }
  | { readonly kind: "algorithm"; readonly message: string }
  | { readonly kind: "integrity"; readonly message: string }
  | { readonly kind: "gzip"; readonly message: string }
  | { readonly kind: "archive"; readonly message: string }
  | { readonly kind: "size"; readonly message: string }
  | { readonly kind: "manifest"; readonly message: string }
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
  const protocol = protocolOf(url)
  if (protocol !== "https:") return { ok: false, error: { kind: "input", message: `tarball ${url} must use https` } }
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
  const bytes = await readAllCapped(response.body.getReader(), cap)
  return bytes === undefined
    ? { ok: false, error: { kind: "size", message: `tarball exceeds ${cap} bytes` } }
    : { ok: true, value: bytes }
}

async function readAllCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cap: number,
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const ManifestSchema = obj({ xin: opt(unknown()) }, { open: true })
const manifestCheck = compile(ManifestSchema)

export async function extractBundle(input: ExtractInput): Promise<BundleResult<ExtractedBundle>> {
  const verified = await verifyIntegrity(input.bytes, input.integrity)
  if (!verified.ok) return verified
  const unpacked = await gunzip(input.bytes, input.cap ?? MAX_UNPACKED_BYTES)
  if (!unpacked.ok) return unpacked
  const manifest = readManifest(unpacked.value)
  if (!manifest.ok) return manifest
  if (manifest.value === undefined)
    return { ok: false, error: { kind: "manifest", message: `tarball has no ${PACKAGE_PREFIX}${MANIFEST}` } }
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(manifest.value))
  } catch (error) {
    return { ok: false, error: { kind: "manifest", message: `${MANIFEST}: ${messageOf(error)}` } }
  }
  if (!manifestCheck.check(document)) {
    const first = manifestCheck.errors(document)[0]
    const detail = first === undefined ? `${MANIFEST} is invalid` : `${MANIFEST}${first.path}: ${first.message}`
    return { ok: false, error: { kind: "manifest", message: detail } }
  }
  return { ok: true, value: { xin: document.xin } }
}

function protocolOf(url: string): string | undefined {
  try {
    return new URL(url).protocol
  } catch {
    return undefined
  }
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
  try {
    const unpacked = await readAllCapped(reader, cap)
    return unpacked === undefined
      ? { ok: false, error: { kind: "size", message: `unpacked tarball exceeds ${cap} bytes` } }
      : { ok: true, value: unpacked }
  } catch (error) {
    return { ok: false, error: { kind: "gzip", message: messageOf(error) } }
  }
}

function readManifest(archive: Uint8Array): BundleResult<Uint8Array | undefined> {
  let found: Uint8Array | undefined
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
    const path = prefix === "" ? name : `${prefix}/${name}`
    if ((type === "0" || type === "\0") && path === `${PACKAGE_PREFIX}${MANIFEST}`) {
      if (found !== undefined) return { ok: false, error: { kind: "archive", message: `tarball repeats ${MANIFEST}` } }
      found = archive.subarray(offset + BLOCK, offset + BLOCK + size)
    }
    offset = next
  }
  return { ok: true, value: found }
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
