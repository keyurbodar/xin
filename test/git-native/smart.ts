const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type Packet = { readonly kind: "data" | "flush" | "delim"; readonly payload: Uint8Array; readonly next: number }

/** A pkt-line: a four-hex-digit length, then that many bytes including the length itself. */
export function readPacket(bytes: Uint8Array, from: number): Packet {
  const size = Number.parseInt(decoder.decode(bytes.subarray(from, from + 4)), 16)
  if (Number.isNaN(size)) throw new Error(`not a pkt-line at ${from}`)
  if (size === 0) return { kind: "flush", payload: new Uint8Array(), next: from + 4 }
  if (size === 1) return { kind: "delim", payload: new Uint8Array(), next: from + 4 }
  return { kind: "data", payload: bytes.subarray(from + 4, from + size), next: from + size }
}

export function packet(text: string): Uint8Array {
  const body = encoder.encode(text)
  const head = encoder.encode((body.length + 4).toString(16).padStart(4, "0"))
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

const FLUSH = encoder.encode("0000")
const DELIM = encoder.encode("0001")
const AGENT = "agent=xin-git-native/0.1"

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

export type Refs = {
  readonly head: string
  readonly branch: string
  readonly refs: ReadonlyMap<string, string>
  readonly capabilities: readonly string[]
  readonly version: 0 | 2
}

function pick(
  refs: ReadonlyMap<string, string>,
  wanted: string | undefined,
  symref: string | undefined,
): { head: string; branch: string } {
  const candidate =
    (wanted === undefined ? undefined : (refs.get(wanted) ?? refs.get(`refs/heads/${wanted}`))) ??
    (symref === undefined ? undefined : refs.get(symref)) ??
    refs.get("refs/heads/main") ??
    refs.get("refs/heads/master") ??
    [...refs.entries()].find(([name]) => name.startsWith("refs/heads/"))?.[1]
  const branch = [...refs.entries()].find(([, oid]) => oid === candidate)?.[0] ?? symref ?? "refs/heads/main"
  if (candidate === undefined) throw new Error("the server advertised no branch")
  return { head: candidate, branch }
}

export function parseRefs(body: Uint8Array): Refs {
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
  return { head, branch, refs, capabilities, version: 0 }
}

function v2Capabilities(body: Uint8Array): string[] {
  const capabilities: string[] = []
  let offset = 0
  let seen = false
  while (offset < body.length) {
    const found = readPacket(body, offset)
    offset = found.next
    if (found.kind !== "data") continue
    const line = decoder.decode(found.payload).trim()
    if (line === "version 2") {
      seen = true
      continue
    }
    if (seen && line !== "") capabilities.push(line)
  }
  return capabilities
}

const isV2 = (body: Uint8Array): boolean => {
  let offset = 0
  while (offset < body.length) {
    const found = readPacket(body, offset)
    offset = found.next
    if (found.kind !== "data") continue
    if (decoder.decode(found.payload).trim() === "version 2") return true
  }
  return false
}

export function parseRefsV2(body: Uint8Array, capabilities: readonly string[], wanted: string | undefined): Refs {
  const refs = new Map<string, string>()
  const symrefs = new Map<string, string>()
  let offset = 0
  while (offset < body.length) {
    const found = readPacket(body, offset)
    offset = found.next
    if (found.kind !== "data") continue
    const line = decoder.decode(found.payload).trim()
    const [oid, name, ...attributes] = line.split(" ")
    if (oid === undefined || name === undefined) continue
    refs.set(name, oid)
    for (const attribute of attributes) {
      if (attribute.startsWith("symref-target:")) symrefs.set(name, attribute.slice("symref-target:".length))
    }
  }
  const { head, branch } = pick(refs, wanted, symrefs.get("HEAD"))
  return { head, branch, refs, capabilities, version: 2 }
}

export type FetchOptions = {
  readonly url: string
  readonly ref?: string
  readonly depth?: number
}

export type Fetched = {
  readonly head: string
  readonly branch: string
  readonly shallow: readonly string[]
  readonly pack: Uint8Array
  readonly fetches: number
  readonly bytes: number
  readonly refsMs: number
  readonly packMs: number
  readonly protocol: 0 | 2
  readonly advertisementBytes: number
}

const HEADERS = { "user-agent": "git/2.0 (xin-git-native)", "git-protocol": "version=2" } as const

async function post(url: string, body: Uint8Array): Promise<Uint8Array> {
  const response = await fetch(`${url}/git-upload-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      ...HEADERS,
    },
    body,
  })
  if (!response.ok) throw new Error(`upload-pack answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
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

/** One smart-HTTP clone: the ref advertisement, then a single `fetch` command. Protocol v2 when offered. */
export async function fetchPack(options: FetchOptions): Promise<Fetched> {
  const started = performance.now()
  const advertisement = await fetch(`${options.url}/info/refs?service=git-upload-pack`, { headers: HEADERS })
  if (!advertisement.ok) throw new Error(`the ref advertisement answered ${advertisement.status}`)
  const advertised = new Uint8Array(await advertisement.arrayBuffer())
  const v2 = isV2(advertised)
  let refs: Refs
  let fetches = 1
  let bytes = advertised.byteLength
  if (v2) {
    const capabilities = v2Capabilities(advertised)
    const listing = await post(
      options.url,
      args("ls-refs", ["peel", "symrefs", "ref-prefix HEAD", "ref-prefix refs/heads/", "ref-prefix refs/tags/"]),
    )
    fetches += 1
    bytes += listing.byteLength
    refs = parseRefsV2(listing, capabilities, options.ref)
  } else {
    refs = parseRefs(advertised)
  }
  const refsMs = performance.now() - started
  const wants = [`want ${refs.head}`]
  if (options.depth !== undefined) wants.push(`deepen ${options.depth}`)
  const packStart = performance.now()
  const answer = v2
    ? await post(options.url, args("fetch", [...wants, "ofs-delta", "no-progress", "done"]))
    : await post(
        options.url,
        join([
          ...wants.map((line, index) =>
            packet(`${line}${index === 0 ? " multi_ack_detailed side-band-64k ofs-delta no-progress" : ""}\n`),
          ),
          FLUSH,
          packet("done\n"),
        ]),
      )
  const packMs = performance.now() - packStart
  const unpacked = demux(answer)
  return {
    head: refs.head,
    branch: refs.branch.replace(/^refs\/heads\//, ""),
    shallow: unpacked.shallow,
    pack: unpacked.pack,
    fetches: fetches + 1,
    bytes: bytes + answer.byteLength,
    refsMs,
    packMs,
    protocol: refs.version,
    advertisementBytes: advertised.byteLength,
  }
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
      if (channel !== 1) {
        if (channel === 3) throw new Error(decoder.decode(found.payload.subarray(1)))
        continue
      }
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
