import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const backend = process.env.XIN_DEV_URL ?? "http://127.0.0.1:8799"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    proxy: {
      "/v1": { target: backend, changeOrigin: true, ws: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
})
