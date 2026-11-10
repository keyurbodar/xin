/**
 * A recorded remote for the native git tests: a real three-commit pack, served the way a smart-HTTP v2 host answers
 * `ls-refs` and `fetch`. The pack has four deltified objects, so reading it exercises delta resolution.
 */
const FULL =
  "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"
const HISTORY =
  "UEFDSwAAAAIAAAAImxZ4nJWPQW7CMBBF9z6F95XJOLZjO0IIVKjURTcVPcA4MymohETGSHD7pnCCzma+9Oe/rymZWaIzjiwZT2AhJNuHWdccg+2oD8Y5TjG56MWEmc9FesOga48mAMfGIDjWBoC6juqm4eQ8+BCMF3gthzHLt+OtXDPLZf8Ua77hMJ14UfhSVlL7aI01dfTyBeYR3TgMx1L4/0nxNREWludxPpB4Jvm522w/dkJshkntD5mR1Pu2lYdSpktbVTOtG4kXc2VVHval2ivQqDsPVhEDKm+aqKKGqOpQJ8tEPXoQr6N6/sek0r2VP3y/Zrl8rEUaCbMO6+8Bj6c/+kr8AtTUb8L3B+1wrrOx2ulROUYmimBnvGT0R2PPeJwNzL0NwjAQBlApJQUzeAT/nM/2AmyR4s7+LGgi5FiCAVggK9JQsAS8Ad53eS/rHIDxTTuqJ6aO2JP6jMqJkpNotVLm7kDQcrrLwDYNWrICDeqaoEQXCrHnLGw5af0vRIlD7ce6ny+3p5lXGNn2B8bxef0AsBkl2vIF7XCus7Ha6VE5RiaKYGe8ZPRHY894nHvNtJdJt6QoNVXBNC3NNC0lLcnUKNnYLMky0dDC0tLIKDEp2cLCIinVOMUoNSUlLTnNbGJssaRjSopCkKuji6+rjkJiQYFCYl6KQl5+SWrxxOctAEGrG0aoBnicMzQwMDMxUQhydXTxddXLTWEQ5/w1/8Cer1YnY/Yfrz+/VEplItdrQ4iivPyS1GK9kooShtowGzZpqydqu6ZmiP6QrImJUGnZY2IABArFRckM9ka1sW7KswTdFvdumn8kWSpkutlsAKnpJi2iAnicMzQwMDMxUUgsKNArKWZ4tXnOizlLnq41EFGU29uVabIi/KQdANywDgb5AS2/7CRk/l97KOxnRxpQvEhvHk65eJzLyJgQIsLd/+Qi41nJKTaizh3XDt0pniCzRRoAir0LEaICeJwzNDAwMzFRSCwo0CspZvDuTFn+/2t/yrLZNrIvLDmTKyS27AUA0GkNlKgGeJwzNDAwMzFRCHJ1dPF11ctNYTjHaKbKzL3i9kq272HT6ufNWTzFzcsQoigvvyS1WK+kooTBYMWlQ4vk2UKurJSfsVKy0ynb39jZxAAIFIqLkhm4+59cZDwrOcVG1Lnj2qE7xRNktkgDAD+tJeyyLb7XkSWxVojaKHAaSk+IdZ2qFA=="

export const FIXTURE_URL = "https://git.example.test/team/project.git"
export const FIXTURE_HEAD = "78eb90fa1cc818751f849d8b2d1eea560e659cc3"
export const FIXTURE_OLD = "ed70aeb3b1dae9513946268a6067bc64f44763cf"
export const FIXTURE_BASE = "73e0127a380e963a05e1300dccd266eb57078837"
export const NOTES_LINES = 300
export const FULL_PACK_BYTES = 1639
export const HISTORY_PACK_BYTES = 913

const bytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

export const FULL_PACK = bytes(FULL)
export const HISTORY_PACK = bytes(HISTORY)

const encoder = new TextEncoder()

const pkt = (text: string): Uint8Array => {
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

const FLUSH = encoder.encode("0000")

const advertisement = (): Uint8Array =>
  join([pkt("# service=git-upload-pack\n"), FLUSH, pkt("version 2\n"), pkt("fetch=shallow\n"), pkt("ls-refs\n"), FLUSH])

const listing = (head: string): Uint8Array =>
  join([pkt(`${head} HEAD symref-target:refs/heads/main\n`), pkt(`${head} refs/heads/main\n`), FLUSH])

/** A packfile section: the `packfile` header, then the bytes as sideband channel 1 packets. */
const packfile = (pack: Uint8Array): Uint8Array => {
  const parts: Uint8Array[] = [pkt("packfile\n")]
  for (let offset = 0; offset < pack.length; offset += 4_000) {
    const chunk = pack.subarray(offset, offset + 4_000)
    const framed = new Uint8Array(chunk.length + 1)
    framed[0] = 1
    framed.set(chunk, 1)
    const head = encoder.encode((framed.length + 4).toString(16).padStart(4, "0"))
    parts.push(head, framed)
  }
  parts.push(FLUSH)
  return join(parts)
}

export type Call = { readonly method: string; readonly url: string; readonly body: string }

export type FakeRemote = { readonly fetch: typeof fetch; readonly calls: Call[] }

/** Answers like a non-GitHub host: nothing here knows about api.github.com. */
export function fakeRemote(
  options: { readonly head?: string; readonly full?: Uint8Array; readonly history?: Uint8Array } = {},
): FakeRemote {
  const calls: Call[] = []
  const head = options.head ?? FIXTURE_HEAD
  const full = options.full ?? FULL_PACK
  const history = options.history ?? HISTORY_PACK
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body === undefined
          ? ""
          : new TextDecoder().decode(init.body as Uint8Array)
    calls.push({ method: init?.method ?? "GET", url, body })
    if (!url.startsWith(FIXTURE_URL)) return new Response("unknown host", { status: 404 })
    if (url === `${FIXTURE_URL}/info/refs?service=git-upload-pack`) return new Response(advertisement())
    if (url !== `${FIXTURE_URL}/git-upload-pack`) return new Response("not found", { status: 404 })
    if (body.includes("command=ls-refs")) return new Response(listing(head))
    if (body.includes("command=fetch"))
      return new Response(packfile(body.includes("filter blob:none") ? history : full))
    return new Response("bad command", { status: 400 })
  }
  return { fetch: impl as typeof fetch, calls }
}
