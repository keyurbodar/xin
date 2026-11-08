import { OpRejected } from "../ops.ts"

export type ConfigSchemaLike = { (value: unknown): unknown; toJSON(): unknown }

export const configSchemaOf = (plugin: unknown): ConfigSchemaLike | undefined => {
  const schema: unknown =
    typeof plugin === "object" || typeof plugin === "function" ? Reflect.get(plugin ?? {}, "Config") : undefined
  return typeof schema === "function" && "toJSON" in schema && typeof schema.toJSON === "function"
    ? (schema as ConfigSchemaLike)
    : undefined
}

export function validateConfig(plugin: string, schema: ConfigSchemaLike, config: unknown): void {
  try {
    schema(config)
  } catch (error) {
    throw new OpRejected("bad_args", `config for ${plugin}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
