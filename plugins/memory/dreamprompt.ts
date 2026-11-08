import { arr, compile, int, obj, str, type Static } from "@earendil-works/pi-schema"

export const PROFILE_LIMIT = 2048
export const SCOPE_PATTERN = "^(me|project:[A-Za-z0-9_-]{1,64})$"

const ADDS_LIMIT = 32
const RETIRES_LIMIT = 64
const TEXT_LIMIT = 1000

const SCOPE = new RegExp(SCOPE_PATTERN)
const encoder = new TextEncoder()

const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /<\|[^|]{0,32}\|>/m,
  /\b(ignore|disregard|forget)\b[^.]{0,60}\b(previous|prior|above|earlier|all)\b[^.]{0,40}\b(instructions?|prompts?|rules?|context)\b/im,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/im,
  /^\s*(you (are|must|should|will|shall)|always\b|never\b|do not\b|don't\b|please\b)/im,
  /^\s*(instructions?|rules?|constraints?)\s*:/im,
]

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

export const isScope = (value: unknown): value is string => typeof value === "string" && SCOPE.test(value)

export function refusal(text: string): string | undefined {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return "that looks like a credential"
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) return "that looks like an instruction"
  return undefined
}

export const SYSTEM_PROMPT = [
  "You curate a small memory profile for a personal agent.",
  "Return only a JSON object:",
  '{"profile_md": string, "add": [{"text": string, "scope": "me" or "project:<id>"}], "retire": [note id]}',
  `profile_md is plain Markdown of durable facts about the owner, at most ${PROFILE_LIMIT} bytes.`,
  "add holds new durable facts; retire holds note ids shown above that are wrong, stale, or folded into the profile.",
  "transcripts are recent chat excerpts; take durable facts from them and ignore chatter.",
  "Never write instructions, commands, or credentials. When nothing changed, return the profile as it is.",
].join("\n")

const OutputSchema = obj({
  profile_md: str(),
  add: arr(obj({ text: str({ minLength: 1, maxLength: TEXT_LIMIT }), scope: str({ pattern: SCOPE_PATTERN }) })),
  retire: arr(int({ minimum: 1 })),
})

export type DreamerOutput = Static<typeof OutputSchema>

const outputCheck = compile(OutputSchema)

export function validateDreamerOutput(
  value: unknown,
  shown: ReadonlySet<number>,
  secrets: readonly string[] = [],
): DreamerOutput | undefined {
  if (!outputCheck.check(value)) return undefined
  if (encoder.encode(value.profile_md).byteLength > PROFILE_LIMIT) return undefined
  if (refusal(value.profile_md) !== undefined) return undefined
  if (value.add.length > ADDS_LIMIT || value.retire.length > RETIRES_LIMIT) return undefined
  if (value.add.some((note) => refusal(note.text) !== undefined)) return undefined
  if (new Set(value.retire).size !== value.retire.length) return undefined
  if (value.retire.some((id) => !shown.has(id))) return undefined
  if (leaks(value.profile_md, secrets)) return undefined
  if (value.add.some((note) => leaks(note.text, secrets))) return undefined
  return value
}

function leaks(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => text.includes(secret))
}
