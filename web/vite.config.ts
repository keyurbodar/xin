import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type PluginOption } from "vite"
import solid from "vite-plugin-solid"
import { frameBundle } from "./visual-frame.ts"

const FRAME_ID = "virtual:visual-frame"

/** `import frame from "virtual:visual-frame"` is the live-visual frame's script as a string, for an iframe's srcdoc. */
function visualFrame(): PluginOption {
  return {
    name: "visual-frame",
    resolveId: (id) => (id === FRAME_ID ? `\0${FRAME_ID}` : undefined),
    async load(id) {
      if (id !== `\0${FRAME_ID}`) return undefined
      const { code, files } = await frameBundle()
      for (const file of files) this.addWatchFile(file)
      return `export default ${JSON.stringify(code)}`
    },
  }
}

const backend = process.env.INGLE_DEV_URL ?? "http://127.0.0.1:8799"

export default defineConfig({
  plugins: [solid(), tailwindcss(), visualFrame()],
  resolve: {
    alias: { "@ingle/sdk": fileURLToPath(new URL("./src/plugins/sdk.ts", import.meta.url)) },
    dedupe: ["solid-js"],
  },
  optimizeDeps: { exclude: ["@ui-sdk/core"] },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "vendor", test: /[\\/]node_modules[\\/]/, tags: ["$initial"] }],
        },
      },
    },
  },
  server: {
    proxy: {
      "/v1": { target: backend, changeOrigin: true, ws: true },
      "/files": { target: backend, changeOrigin: true },
      "/blobs": { target: backend, changeOrigin: true },
      "/s/": { target: backend, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
      "/hooks": { target: backend, changeOrigin: true },
    },
  },
})
