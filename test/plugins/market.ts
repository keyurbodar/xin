const BLOCK = 512
const encoder = new TextEncoder()

export type TarFile = {
  readonly path: string
  readonly data: string | Uint8Array
  readonly type?: "0" | "2" | "5"
}

export function ustar(files: readonly TarFile[]): Uint8Array {
  const blocks: Uint8Array[] = files.map(entryBlocks)
  blocks.push(new Uint8Array(BLOCK * 2))
  return concatenate(blocks)
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function tarball(files: Readonly<Record<string, string | Uint8Array>>): Promise<Uint8Array> {
  const entries = Object.entries(files).map(([path, data]) => ({ path: `package/${path}`, data }))
  return gzip(ustar(entries))
}

export async function integrityOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes))
  return `sha512-${base64(digest)}`
}

function entryBlocks(file: TarFile): Uint8Array {
  const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data
  const type = file.type ?? "0"
  const split = splitPath(file.path)
  const header = new Uint8Array(BLOCK)
  write(header, 0, split.name, 100)
  write(header, 100, "0000644", 8)
  write(header, 108, "0000000", 8)
  write(header, 116, "0000000", 8)
  write(header, 124, data.byteLength.toString(8).padStart(11, "0"), 12)
  write(header, 136, "00000000000", 12)
  header.fill(0x20, 148, 156)
  header[156] = type.charCodeAt(0)
  write(header, 257, "ustar", 6)
  write(header, 263, "00", 2)
  write(header, 345, split.prefix, 155)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  write(header, 148, checksum.toString(8).padStart(6, "0"), 6)
  header[154] = 0
  header[155] = 0x20
  const padded = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK)
  padded.set(data)
  const block = new Uint8Array(BLOCK + padded.byteLength)
  block.set(header)
  block.set(padded, BLOCK)
  return block
}

function splitPath(path: string): { readonly name: string; readonly prefix: string } {
  if (encoder.encode(path).byteLength <= 100) return { name: path, prefix: "" }
  let index = path.lastIndexOf("/")
  while (index > 0) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (encoder.encode(prefix).byteLength <= 155 && encoder.encode(name).byteLength <= 100) return { name, prefix }
    index = path.lastIndexOf("/", index - 1)
  }
  throw new Error(`tar path does not fit ustar: ${path}`)
}

function write(block: Uint8Array, offset: number, value: string, length: number): void {
  const bytes = encoder.encode(value)
  if (bytes.byteLength > length) throw new Error(`tar field ${value} does not fit in ${length} bytes`)
  block.set(bytes, offset)
}

function concatenate(blocks: readonly Uint8Array[]): Uint8Array {
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    joined.set(block, offset)
    offset += block.byteLength
  }
  return joined
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
