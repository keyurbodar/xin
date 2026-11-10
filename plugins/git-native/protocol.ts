const encoder = new TextEncoder()
const decoder = new TextDecoder()

const AGENT = "agent=xin-git-native/0.1"
const FLUSH = encoder.encode("0000")
const DELIM = encoder.encode("0001")
const USER_AGENT = "git/2.0 (xin-git-native)"

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

type Packet = { readonly kind: "data" | "flush" | "delim"; readonly payload: Uint8Array; readonly next: number }

function readPacket(bytes: Uint8Array, from: number): Packet {
  const size = Number.parseInt(decoder.decode(bytes.subarray(from, from + 4)), 16)
  if (Number.isNaN(size)) throw new Error(`not a pkt-line at ${from}`)
  if (size === 0) return { kind: "flush", payload: new Uint8Array(), next: from + 4 }
  if (size === 1) return { kind: "delim", payload: new Uint8Array(), next: from + 4 }
  return { kind: "data", payload: bytes.subarray(from + 4, from + size), next: from + size }
}

function packet(text: string): Uint8Array {
  const body = encoder.encode(text)
  const head = encoder.encode((body.length + 4).toString(16).padStart(4, "0"))
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let write = 0
  for (const part of parts) {
    out.set(part, write)
    write += part.byteLength
  }
  return out
}

const args = (command: string, extra: readonly string[]): Uint8Array =>
  join([
    packet(`command=${command}\n`),
    packet(`${AGENT}\n`),
    packet("object-format=sha1\n"),
    DELIM,
    ...extra.map((line) => packet(`${line}\n`)),
    FLUSH,
  ])

export type Refs = {
  readonly head: string
  readonly branch: string
  readonly refs: ReadonlyMap<string, string>
  readonly protocol: 0 | 2
}

/** Only an http(s) URL without credentials, because this path is unauthenticated and public-only. */
export function remoteUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error(`"${input}" is not a URL`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("a git remote must be http or https")
  if (url.username !== "" || url.password !== "") throw new Error("a git remote may not carry credentials")
  url.hash = ""
  url.search = ""
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

function pick(
  refs: ReadonlyMap<string, string>,
  wanted: string | undefined,
  symref: string | undefined,
): { head: string; branch: string } {
  const candidate =
    (wanted === undefined
      ? undefined
      : (refs.get(wanted) ?? refs.get(`refs/heads/${wanted}`) ?? refs.get(`refs/tags/${wanted}`))) ??
    (symref === undefined ? undefined : refs.get(symref)) ??
    refs.get("refs/heads/main") ??
    refs.get("refs/heads/master") ??
    [...refs.entries()].find(([name]) => name.startsWith("refs/heads/"))?.[1]
  if (candidate === undefined) throw new Error("the server advertised no branch")
  const branch =
    [...refs.entries()].find(([name, oid]) => oid === candidate && name.startsWith("refs/heads/"))?.[0] ??
    symref ??
    [...refs.keys()].find((name) => name.startsWith("refs/heads/")) ??
    "refs/heads/main"
  return { head: candidate, branch }
}

function parseRefsV2(body: Uint8Array, wanted: string | undefined): Refs {
  const refs = new Map<string, string>()
  const symrefs = new Map<string, string>()
  let offset = 0
  while (offset < body.length) {
    const found = readPacket(body, offset)
    offset = found.next
    if (found.kind !== "data") continue
    const [oid, name, ...attributes] = decoder.decode(found.payload).trim().split(" ")
    if (oid === undefined || name === undefined || name === "") continue
    refs.set(name, oid)
    for (const attribute of attributes) {
      if (attribute.startsWith("symref-target:")) symrefs.set(name, attribute.slice("symref-target:".length))
      // An annotated tag points at a tag object; its peeled line is the commit this reader can walk.
      if (attribute.startsWith("peeled:")) refs.set(name, attribute.slice("peeled:".length))
    }
  }
  const { head, branch } = pick(refs, wanted, symrefs.get("HEAD"))
  return { head, branch, refs, protocol: 2 }
}

function parseRefsV0(body: Uint8Array): Refs {
  const refs = new Map<string, string>()
  let capabilities: string[] = []
  let offset = 0
  let first = true
  while (offset < body.length) {
    const found = readPacket(body, offset)
    offset = found.next
    if (found.kind !== "data") continue
    const line = decoder.decode(found.payload).replace(/\n$/, "")
    if (line.startsWith("#")) continue
    const [left, caps] = line.split("\u0000")
    if (caps !== undefined && first) capabilities = caps.trim().split(" ")
    first = false
    const space = (left ?? "").indexOf(" ")
    if (space < 0) continue
    refs.set((left ?? "").slice(space + 1), (left ?? "").slice(0, space))
  }
  const symref = capabilities.find((cap) => cap.startsWith("symref=HEAD:"))?.slice("symref=HEAD:".length)
  const { head, branch } = pick(refs, undefined, symref)
  return { head, branch, refs, protocol: 0 }
}

const isV2 = (body: Uint8Array): boolean => {
  let offset = 0
  while (offset < body.length) {
    const found = readPacket(body, offset)
    offset = found.next
    if (found.kind === "data" && decoder.decode(found.payload).trim() === "version 2") return true
  }
  return false
}

/** Reads a response body into one buffer, giving up as soon as it passes `maxBytes` instead of holding it. */
async function capped(
  response: Response,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array } | { readonly tooLarge: number }> {
  const body = response.body
  if (body === null) return { bytes: new Uint8Array() }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return { tooLarge: total }
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let write = 0
  for (const chunk of chunks) {
    bytes.set(chunk, write)
    write += chunk.byteLength
  }
  return { bytes }
}

async function post(fetcher: Fetcher, url: string, body: Uint8Array): Promise<Response> {
  const response = await fetcher(`${url}/git-upload-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "user-agent": USER_AGENT,
      "git-protocol": "version=2",
    },
    body,
  })
  if (!response.ok) throw new Error(`upload-pack answered ${response.status}`)
  return response
}

export type RemoteOptions = {
  readonly url: string
  readonly ref?: string
  readonly depth?: number
  /** Ask for history without file contents, so a large repository still fits. */
  readonly blobs?: boolean
  readonly maxBytes: number
}

export type Fetched = {
  readonly refs: Refs
  readonly shallow: readonly string[]
  readonly pack: Uint8Array
  readonly bytes: number
  readonly fetches: number
}

export type FetchOutcome = Fetched | { readonly tooLarge: number; readonly fetches: number; readonly bytes: number }

/** The ref advertisement and the wanted refs, without a packfile. */
export async function advertise(
  fetcher: Fetcher,
  options: RemoteOptions,
): Promise<{ refs: Refs; bytes: number; fetches: number }> {
  const response = await fetcher(`${options.url}/info/refs?service=git-upload-pack`, {
    headers: { "user-agent": USER_AGENT, "git-protocol": "version=2", accept: "*/*" },
  })
  if (!response.ok) throw new Error(`the ref advertisement answered ${response.status}`)
  const read = await capped(response, options.maxBytes)
  if ("tooLarge" in read) throw new Error("the ref advertisement is too large")
  let refs: Refs
  let bytes = read.bytes.byteLength
  let fetches = 1
  if (isV2(read.bytes)) {
    const listing = await post(
      fetcher,
      options.url,
      args("ls-refs", ["peel", "symrefs", "ref-prefix HEAD", "ref-prefix refs/heads/", "ref-prefix refs/tags/"]),
    )
    const listed = await capped(listing, options.maxBytes)
    if ("tooLarge" in listed) throw new Error("the ref listing is too large")
    bytes += listed.bytes.byteLength
    fetches += 1
    refs = parseRefsV2(listed.bytes, options.ref)
  } else {
    refs = parseRefsV0(read.bytes)
  }
  return { refs, bytes, fetches }
}

/** One `fetch` command. `wants` defaults to the wanted ref, and `blobs: false` asks for a partial pack. */
export async function fetchPack(
  fetcher: Fetcher,
  options: RemoteOptions & { readonly wants?: readonly string[] },
): Promise<FetchOutcome> {
  const advertised = await advertise(fetcher, options)
  const wants = options.wants ?? [advertised.refs.head]
  if (options.blobs === false && advertised.refs.protocol === 0)
    throw new Error("this host does not offer protocol v2, so it cannot serve a history-only clone")
  const extra = wants.map((oid) => `want ${oid}`)
  if (options.depth !== undefined) extra.push(`deepen ${options.depth}`)
  extra.push("ofs-delta", "no-progress", "done")
  if (options.blobs === false) extra.push("filter blob:none")
  const body =
    advertised.refs.protocol === 2
      ? args("fetch", extra)
      : join([
          ...wants.map((oid, index) =>
            packet(`want ${oid}${index === 0 ? " multi_ack_detailed side-band-64k ofs-delta no-progress" : ""}\n`),
          ),
          ...(options.depth === undefined ? [] : [packet(`deepen ${options.depth}\n`)]),
          FLUSH,
          packet("done\n"),
        ])
  const response = await post(fetcher, options.url, body)
  const read = await capped(response, options.maxBytes)
  const bytes = advertised.bytes + ("tooLarge" in read ? 0 : read.bytes.byteLength)
  const fetches = advertised.fetches + 1
  if ("tooLarge" in read) return { tooLarge: read.tooLarge, bytes, fetches }
  const demuxed = demux(read.bytes)
  return { refs: advertised.refs, shallow: demuxed.shallow, pack: demuxed.pack, bytes, fetches }
}

function demux(answer: Uint8Array): { pack: Uint8Array; shallow: string[] } {
  const chunks: Uint8Array[] = []
  const shallow: string[] = []
  let total = 0
  let offset = 0
  while (offset < answer.length) {
    if (
      answer[offset] === 0x50 &&
      answer[offset + 1] === 0x41 &&
      answer[offset + 2] === 0x43 &&
      answer[offset + 3] === 0x4b
    ) {
      chunks.push(answer.subarray(offset))
      total += answer.length - offset
      break
    }
    const found = readPacket(answer, offset)
    offset = found.next
    if (found.kind !== "data") continue
    const channel = found.payload[0]
    if (channel === 1 || channel === 2 || channel === 3) {
      if (channel === 3) throw new Error(decoder.decode(found.payload.subarray(1)).trim())
      if (channel === 2) continue
      chunks.push(found.payload.subarray(1))
      total += found.payload.length - 1
      continue
    }
    const line = decoder.decode(found.payload).trim()
    if (line.startsWith("shallow ")) shallow.push(line.slice("shallow ".length))
  }
  const pack = new Uint8Array(total)
  let write = 0
  for (const chunk of chunks) {
    pack.set(chunk, write)
    write += chunk.byteLength
  }
  return { pack, shallow }
}
