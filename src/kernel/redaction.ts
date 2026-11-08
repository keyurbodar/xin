import type { JsonValue } from "@earendil-works/chord"
import { defineExtension, type Extension, hook, type ToolExecutionResult, ToolTask } from "@earendil-works/pi-durable"

const REDACTED = "[redacted]"

const redact = (text: string, secrets: readonly string[]): string => {
  let redacted = text
  for (const secret of secrets) redacted = redacted.split(secret).join(REDACTED)
  return redacted
}

const redactValue = (value: JsonValue, secrets: readonly string[]): JsonValue => {
  if (typeof value === "string") return redact(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]))
  return value
}

const redactResult = (result: ToolExecutionResult, secrets: readonly string[]): ToolExecutionResult => ({
  ...result,
  ...(result.output === undefined
    ? {}
    : {
        output: result.output.map((part) =>
          part.type === "text" ? { ...part, text: redact(part.text, secrets) } : part,
        ),
      }),
  ...(result.structuredOutput === undefined ? {} : { structuredOutput: redactValue(result.structuredOutput, secrets) }),
  ...(result.details === undefined ? {} : { details: redactValue(result.details, secrets) }),
})

export function redactionExtension(secrets: () => readonly string[]): Extension {
  return defineExtension({
    name: "core.redaction",
    hooks: [
      hook(ToolTask, {
        afterTool: (_call, result) => {
          const values = secrets()
          return values.length === 0 ? result : redactResult(result, values)
        },
      }),
    ],
  })
}
