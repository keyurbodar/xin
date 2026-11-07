import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { configureRow, errorMessage, isRecord } from "../../state/extensions.ts"
import { Button, Failure, INPUT, MONO_INPUT, Note, Toggle } from "./chrome.tsx"

export type ConfigField = {
  readonly key: string
  readonly label: string
  readonly description?: string | undefined
} & (
  | { readonly kind: "text"; readonly value: string; readonly pattern?: string | undefined }
  | { readonly kind: "number"; readonly value: string; readonly min?: number | undefined; readonly max?: number | undefined }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "list"; readonly value: string; readonly itemPattern?: string | undefined }
  | { readonly kind: "select"; readonly value: string; readonly options: readonly string[] }
  | { readonly kind: "json"; readonly value: string }
)

export function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function resolveNode(refs: Readonly<Record<string, unknown>>, value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value === "number") {
    const found = refs[String(value)]
    return isRecord(found) ? found : undefined
  }
  return isRecord(value) ? value : undefined
}

function patternOf(meta: Readonly<Record<string, unknown>>): string | undefined {
  const pattern = meta["pattern"]
  if (typeof pattern === "string") return pattern
  if (!isRecord(pattern)) return undefined
  const source = pattern["source"]
  return typeof source === "string" ? source : undefined
}

function optionsOf(node: Readonly<Record<string, unknown>>, refs: Readonly<Record<string, unknown>>): readonly string[] {
  const constant = node["value"]
  if (node["type"] === "const" && typeof constant === "string") return [constant]
  if (node["type"] !== "union" || !Array.isArray(node["list"])) return []
  return node["list"].flatMap((entry) => {
    const member = resolveNode(refs, entry)
    if (member === undefined || member["type"] !== "const") return []
    const value = member["value"]
    return typeof value === "string" ? [value] : []
  })
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string").join("\n")
  if (value === undefined || value === null) return ""
  return JSON.stringify(value, null, 2)
}

function fieldOf(
  key: string,
  node: Readonly<Record<string, unknown>>,
  refs: Readonly<Record<string, unknown>>,
  config: Readonly<Record<string, unknown>>,
): ConfigField {
  const meta: Readonly<Record<string, unknown>> = isRecord(node["meta"]) ? node["meta"] : {}
  const described = meta["description"]
  const description = typeof described === "string" ? described : undefined
  const current = Object.hasOwn(config, key) ? config[key] : meta["default"]
  const label = humanize(key)
  const base = { key, label, description }
  const pattern = patternOf(meta)
  switch (node["type"]) {
    case "string":
    case "const":
      return { ...base, kind: "text", value: textValue(current), pattern }
    case "number": {
      const minimum = meta["min"]
      const maximum = meta["max"]
      const min = typeof minimum === "number" ? minimum : undefined
      const max = typeof maximum === "number" ? maximum : undefined
      return { ...base, kind: "number", value: typeof current === "number" ? String(current) : "", min, max }
    }
    case "boolean":
      return { ...base, kind: "boolean", value: current === true }
    case "array": {
      const inner = resolveNode(refs, node["inner"])
      const innerMetaValue = inner === undefined ? undefined : inner["meta"]
      const innerMeta: Readonly<Record<string, unknown>> = isRecord(innerMetaValue) ? innerMetaValue : {}
      const itemPattern = patternOf(innerMeta)
      return { ...base, kind: "list", value: textValue(current), itemPattern }
    }
    case "union": {
      const options = optionsOf(node, refs)
      if (options.length >= 2) return { ...base, kind: "select", value: typeof current === "string" ? current : "", options }
      return { ...base, kind: "json", value: textValue(current) }
    }
    default:
      return { ...base, kind: "json", value: textValue(current) }
  }
}

export function fieldsOf(schema: unknown, config: Readonly<Record<string, unknown>>): readonly ConfigField[] {
  if (!isRecord(schema)) return []
  const refs = isRecord(schema["refs"]) ? schema["refs"] : undefined
  const uid = schema["uid"]
  if (refs === undefined || typeof uid !== "number") return []
  const root = resolveNode(refs, uid)
  if (root === undefined || !isRecord(root["dict"])) return []
  return Object.entries(root["dict"]).flatMap(([key, reference]) => {
    const node = resolveNode(refs, reference)
    return node === undefined ? [] : [fieldOf(key, node, refs, config)]
  })
}

function regexOf(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "u")
  } catch {
    return undefined
  }
}

function problemsOf(fields: readonly ConfigField[]): ReadonlyMap<string, string> {
  const problems = new Map<string, string>()
  for (const field of fields) {
    switch (field.kind) {
      case "text": {
        const regex = field.pattern === undefined ? undefined : regexOf(field.pattern)
        if (regex !== undefined && field.value.trim() !== "" && !regex.test(field.value.trim()))
          problems.set(field.key, "Does not match the required format")
        break
      }
      case "number": {
        if (field.value.trim() === "") break
        const parsed = Number(field.value)
        if (!Number.isFinite(parsed)) problems.set(field.key, "Must be a number")
        else if (field.min !== undefined && parsed < field.min) problems.set(field.key, `Minimum ${field.min}`)
        else if (field.max !== undefined && parsed > field.max) problems.set(field.key, `Maximum ${field.max}`)
        break
      }
      case "list": {
        const regex = field.itemPattern === undefined ? undefined : regexOf(field.itemPattern)
        if (regex === undefined) break
        for (const line of field.value.split("\n")) {
          if (line.trim() !== "" && !regex.test(line.trim())) {
            problems.set(field.key, `Each entry must match ${field.itemPattern ?? ""}`)
            break
          }
        }
        break
      }
      case "json": {
        if (field.value.trim() === "") break
        try {
          JSON.parse(field.value)
        } catch {
          problems.set(field.key, "Not valid JSON")
        }
        break
      }
      default:
        break
    }
  }
  return problems
}

function configOf(fields: readonly ConfigField[]): Readonly<Record<string, unknown>> {
  const config: Record<string, unknown> = {}
  for (const field of fields) {
    switch (field.kind) {
      case "text":
      case "select":
        if (field.value.trim() !== "") config[field.key] = field.value.trim()
        break
      case "number":
        if (field.value.trim() !== "") config[field.key] = Number(field.value)
        break
      case "boolean":
        config[field.key] = field.value
        break
      case "list": {
        const entries = field.value
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
        if (entries.length > 0) config[field.key] = entries
        break
      }
      case "json":
        if (field.value.trim() !== "") config[field.key] = JSON.parse(field.value)
        break
    }
  }
  return config
}

export function ConfigForm(props: {
  rowId: string
  schema: unknown
  config: Readonly<Record<string, unknown>>
  onSaved?: (() => void) | undefined
}): JSX.Element {
  const initialSchema = fieldsOf(props.schema, props.config)
  const [fields, setFields] = createSignal<readonly ConfigField[]>(initialSchema)
  const [mode, setMode] = createSignal<"form" | "raw">(initialSchema.length === 0 ? "raw" : "form")
  const [raw, setRaw] = createSignal(JSON.stringify(props.config, null, 2))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [saved, setSaved] = createSignal(false)

  // The advanced list swaps rows inside one mounted form; carry the draft to the new row.
  let carried = props.rowId
  createEffect(() => {
    const id = props.rowId
    if (id === carried) return
    carried = id
    const next = fieldsOf(props.schema, props.config)
    setFields(next)
    setMode(next.length === 0 ? "raw" : "form")
    setRaw(JSON.stringify(props.config, null, 2))
    setSaved(false)
    setError(undefined)
  })

  const problems = (): ReadonlyMap<string, string> => problemsOf(fields())

  const update = (key: string, change: (field: ConfigField) => ConfigField): void => {
    setSaved(false)
    setFields((current) => current.map((field) => (field.key === key ? change(field) : field)))
  }

  const save = async (): Promise<void> => {
    setError(undefined)
    if (problems().size > 0) return
    let config: Readonly<Record<string, unknown>>
    if (mode() === "raw") {
      try {
        const parsed: unknown = JSON.parse(raw())
        if (!isRecord(parsed)) {
          setError("Raw config must be a JSON object")
          return
        }
        config = parsed
      } catch (failure: unknown) {
        setError(errorMessage(failure))
        return
      }
    } else {
      config = configOf(fields())
    }
    setBusy(true)
    try {
      await configureRow(props.rowId, config)
      setSaved(true)
      props.onSaved?.()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex min-h-0 flex-col gap-3">
      <div class="flex items-center gap-2">
        <span class="label">Settings</span>
        <div class="ml-auto flex items-center gap-0.5 rounded-[2px] border border-line-inner p-px">
          <button
            type="button"
            onClick={() => setMode("form")}
            class="h-6 rounded-[1px] px-2 text-[11.5px] transition-none"
            classList={{ "bg-selected text-fg": mode() === "form", "text-fg-3": mode() !== "form" }}
          >
            Form
          </button>
          <button
            type="button"
            onClick={() => {
              setRaw(JSON.stringify(configOf(fields()), null, 2))
              setMode("raw")
            }}
            class="h-6 rounded-[1px] px-2 font-mono text-[11px] transition-none"
            classList={{ "bg-selected text-fg": mode() === "raw", "text-fg-3": mode() !== "raw" }}
          >
            Raw
          </button>
        </div>
      </div>

      <Show
        when={mode() === "form"}
        fallback={
          <textarea
            value={raw()}
            onInput={(event) => {
              setSaved(false)
              setRaw(event.currentTarget.value)
            }}
            spellcheck={false}
            class="min-h-[220px] w-full resize-y rounded-[2px] border border-line-inner bg-page p-3 font-mono text-[11.5px] leading-relaxed text-fg focus:border-line-strong focus:outline-none"
            aria-label="Raw config JSON"
          />
        }
      >
        <Show
          when={fields().length > 0}
          fallback={
            <div class="rounded-[4px] border border-dashed border-line-inner px-3.5 py-4">
              <p class="text-[12.5px] text-fg-2">This row declares no settings schema.</p>
              <p class="mt-1 text-[11.5px] text-fg-3">
                Raw mode still writes a config object through plugin.configure, if the row accepts one.
              </p>
            </div>
          }
        >
          <div class="flex flex-col overflow-hidden rounded-[4px] border border-line">
            <For each={fields()}>
              {(field) => {
                const problem = () => problems().get(field.key)
                return (
                  <div class="grid grid-cols-[200px_1fr] items-start gap-4 border-b border-line px-3.5 py-3 last:border-0">
                    <div class="min-w-0">
                      <span class="block text-[12.5px] text-fg">{field.label}</span>
                      <span class="mono-meta block">{field.key}</span>
                      <Show when={field.description}>
                        {(description) => <span class="mt-1 block text-[11.5px] leading-snug text-fg-3">{description()}</span>}
                      </Show>
                    </div>
                    <div class="min-w-0">
                      <Show when={field.kind === "text" ? field : undefined}>
                        {(text) => (
                          <input
                            value={text().value}
                            onInput={(event) =>
                              update(field.key, (current) =>
                                current.kind === "text" ? { ...current, value: event.currentTarget.value } : current,
                              )
                            }
                            spellcheck={false}
                            class={INPUT}
                            classList={{ "border-bad/50": problem() !== undefined }}
                          />
                        )}
                      </Show>
                      <Show when={field.kind === "number" ? field : undefined}>
                        {(number) => (
                          <input
                            type="number"
                            value={number().value}
                            min={number().min}
                            max={number().max}
                            onInput={(event) =>
                              update(field.key, (current) =>
                                current.kind === "number" ? { ...current, value: event.currentTarget.value } : current,
                              )
                            }
                            class={`${INPUT} max-w-[160px] font-mono`}
                            classList={{ "border-bad/50": problem() !== undefined }}
                          />
                        )}
                      </Show>
                      <Show when={field.kind === "boolean" ? field : undefined}>
                        {(toggle) => (
                          <Toggle
                            on={toggle().value}
                            label={field.label}
                            onChange={(next) =>
                              update(field.key, (current) =>
                                current.kind === "boolean" ? { ...current, value: next } : current,
                              )
                            }
                          />
                        )}
                      </Show>
                      <Show when={field.kind === "list" ? field : undefined}>
                        {(list) => (
                          <textarea
                            value={list().value}
                            onInput={(event) =>
                              update(field.key, (current) =>
                                current.kind === "list" ? { ...current, value: event.currentTarget.value } : current,
                              )
                            }
                            spellcheck={false}
                            placeholder="One entry per line"
                            class={`${MONO_INPUT} h-auto min-h-[64px] resize-y py-2 leading-relaxed`}
                            classList={{ "border-bad/50": problem() !== undefined }}
                          />
                        )}
                      </Show>
                      <Show when={field.kind === "select" ? field : undefined}>
                        {(select) => (
                          <select
                            value={select().value}
                            onChange={(event) =>
                              update(field.key, (current) =>
                                current.kind === "select" ? { ...current, value: event.currentTarget.value } : current,
                              )
                            }
                            class={`${INPUT} max-w-[220px]`}
                          >
                            <option value="">Default</option>
                            <For each={select().options}>
                              {(option) => <option value={option}>{option}</option>}
                            </For>
                          </select>
                        )}
                      </Show>
                      <Show when={field.kind === "json" ? field : undefined}>
                        {(json) => (
                          <textarea
                            value={json().value}
                            onInput={(event) =>
                              update(field.key, (current) =>
                                current.kind === "json" ? { ...current, value: event.currentTarget.value } : current,
                              )
                            }
                            spellcheck={false}
                            class={`${MONO_INPUT} h-auto min-h-[64px] resize-y py-2 leading-relaxed`}
                            classList={{ "border-bad/50": problem() !== undefined }}
                          />
                        )}
                      </Show>
                      <Show when={problem()}>
                        {(message) => <span class="mt-1 block text-[11.5px] text-bad">{message()}</span>}
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={error()}>
        {(message) => <Failure message={message()} />}
      </Show>

      <div class="flex items-center gap-2">
        <Show when={problems().size > 0}>
          <span class="text-[11.5px] text-bad">
            {problems().size} {problems().size === 1 ? "field needs" : "fields need"} fixing
          </span>
        </Show>
        <Show when={saved()}>
          <span class="flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <GlyphCheck /> Saved
          </span>
        </Show>
        <span class="ml-auto" />
        <Button
          size="sm"
          variant="primary"
          disabled={busy() || problems().size > 0}
          onClick={() => void save()}
        >
          {busy() ? "Saving" : "Save"}
        </Button>
      </div>
      <Note>Changes restart the row. Values left blank fall back to the package default.</Note>
    </div>
  )
}

function GlyphCheck(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  )
}
