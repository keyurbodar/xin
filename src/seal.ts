const encoder = new TextEncoder()
const decoder = new TextDecoder()

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

export type Sealed = { readonly iv: string; readonly data: string }

export class Sealer {
  readonly #key: Promise<CryptoKey>

  constructor(kek: string) {
    const raw = fromBase64(kek)
    if (raw.byteLength !== 32) throw new Error("KEK must be 32 bytes, base64")
    this.#key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])
  }

  async seal(plain: string, label: string): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const params = { name: "AES-GCM", iv, additionalData: encoder.encode(label) }
    const data = new Uint8Array(await crypto.subtle.encrypt(params, await this.#key, encoder.encode(plain)))
    return { iv: toBase64(iv), data: toBase64(data) }
  }

  async unseal(sealed: Sealed, label: string): Promise<string> {
    const params = { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(label) }
    return decoder.decode(await crypto.subtle.decrypt(params, await this.#key, fromBase64(sealed.data)))
  }
}
