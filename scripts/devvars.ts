/** The throwaway owner token `plugin dev` runs with when there is no `.dev.vars`. */
export const DEV_TOKEN = "dev-owner-token"

/** The throwaway key-encryption key `plugin dev` runs with when there is no `.dev.vars`: 32 bytes, base64, as `Sealer` needs. */
export const DEV_KEK = btoa("ingle-plugin-dev-kek-local-only!")
