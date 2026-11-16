import type { JsonValue } from "@earendil-works/chord"

/** One settings field, derived from a plugin's schemastery `Config` so the client renders a form without parsing schemas. */
export type FormField = {
  readonly key: string
  readonly type: "string" | "secret" | "number" | "boolean" | "select" | "list" | "group" | "json"
  readonly label: string
  readonly description?: string
  readonly default?: JsonValue
  readonly required: boolean
  readonly options?: readonly JsonValue[]
  readonly min?: number
  readonly max?: number
  readonly fields?: readonly FormField[]
}

type Node = {
  readonly type?: unknown
  readonly meta?: Readonly<Record<string, unknown>>
  readonly dict?: Readonly<Record<string, Node>>
  readonly list?: readonly Node[]
  readonly inner?: Node
  readonly value?: unknown
}

const asNode = (value: unknown): Node => (typeof value === "function" || typeof value === "object" ? (value ?? {}) : {})

const text = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const first = Object.values(value).find((entry) => typeof entry === "string")
    return typeof first === "string" ? first : undefined
  }
  return undefined
}

const json = (value: unknown): JsonValue | undefined =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as JsonValue)

const label = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function kindOf(node: Node): Pick<FormField, "type" | "options" | "fields"> {
  const options = node.type === "union" ? (node.list ?? []).map(asNode) : []
  if (options.length > 0 && options.every((option) => option.type === "const"))
    return { type: "select", options: options.map((option) => json(option.value) ?? null) }
  switch (node.type) {
    case "string":
      return { type: node.meta?.["role"] === "secret" ? "secret" : "string" }
    case "number":
    case "natural":
    case "percent":
      return { type: "number" }
    case "boolean":
      return { type: "boolean" }
    case "array":
      return { type: "list" }
    case "object":
      return { type: "group", fields: fieldsOf(node) }
    default:
      return { type: "json" }
  }
}

function fieldsOf(node: Node): readonly FormField[] {
  return Object.entries(node.dict ?? {}).map(([key, child]) => {
    const meta = child.meta ?? {}
    const description = text(meta["description"])
    const fallback = json(meta["default"])
    const { min, max } = meta
    return {
      key,
      label: label(key),
      ...kindOf(child),
      required: meta["required"] === true,
      ...(description === undefined ? {} : { description }),
      ...(fallback === undefined ? {} : { default: fallback }),
      ...(typeof min === "number" ? { min } : {}),
      ...(typeof max === "number" ? { max } : {}),
    }
  })
}

/** The top-level fields of an object `Config`; an empty list for anything else. */
export const formOf = (schema: unknown): readonly FormField[] => {
  const node = asNode(schema)
  return node.type === "object" ? fieldsOf(node) : []
}
