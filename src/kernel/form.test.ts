import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"
import { formOf } from "./form.ts"
import { Schema } from "./index.ts"

type CatalogEntry = {
  readonly name: string
  readonly version: string
  readonly permissions: readonly { readonly id: string; readonly title: string }[]
  readonly form: readonly { readonly key: string; readonly type: string }[]
}

describe("settings form", () => {
  it("derives one field per config key with its kind, default and bounds", () => {
    const form = formOf(
      Schema.object({
        greeting: Schema.string().default("hi").description("What to say"),
        retries: Schema.number().min(1).max(5).default(2),
        loud: Schema.boolean().default(false),
        mode: Schema.union(["short", "long"]).default("short"),
        token: Schema.string().role("secret").required(),
        tags: Schema.array(String).default([]),
        nested: Schema.object({ city: Schema.string() }),
      }),
    )
    expect(form).toEqual([
      {
        key: "greeting",
        label: "Greeting",
        type: "string",
        required: false,
        description: "What to say",
        default: "hi",
      },
      { key: "retries", label: "Retries", type: "number", required: false, default: 2, min: 1, max: 5 },
      { key: "loud", label: "Loud", type: "boolean", required: false, default: false },
      { key: "mode", label: "Mode", type: "select", options: ["short", "long"], required: false, default: "short" },
      { key: "token", label: "Token", type: "secret", required: true },
      { key: "tags", label: "Tags", type: "list", required: false, default: [] },
      {
        key: "nested",
        label: "Nested",
        type: "group",
        fields: [{ key: "city", label: "City", type: "string", required: false }],
        required: false,
        default: {},
      },
    ])
  })

  it("is served with each catalog entry, beside its version and permission titles", async () => {
    const ack = await cmd(fresh(), "catalog", "plugin.catalog")
    expect(ack.ok, JSON.stringify(ack)).toBe(true)
    const entries = ack.result as readonly CatalogEntry[]
    const hello = entries.find((entry) => entry.name === "hello")
    expect(hello?.version).toBe("0.1.0")
    expect(hello?.form.map((field) => field.key)).toEqual(["greeting"])
    const web = entries.find((entry) => entry.name === "tool-web")
    expect(web?.permissions).toEqual([
      { id: "network", title: "Connect to the internet" },
      { id: "secrets", title: "Read your stored credentials" },
    ])
  })
})
