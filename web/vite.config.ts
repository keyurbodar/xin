import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const backend = process.env.INGLE_DEV_URL ?? "http://127.0.0.1:8799"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: { "@ingle/sdk": fileURLToPath(new URL("./src/plugins/sdk.ts", import.meta.url)) },
    dedupe: ["solid-js"],
  },
  server: {
    proxy: {
      "/v1": { target: backend, changeOrigin: true, ws: true },
      "/files": { target: backend, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
})
