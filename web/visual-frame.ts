import { join } from "node:path"
import { rolldown } from "rolldown"

const ENTRY = join(import.meta.dirname, "../plugins/visual/frame/main.ts")
const NODE_ONLY = new Set(["fs", "path", "os", "crypto", "tty", "child_process", "readline-sync", "tmp"])

/** The sandboxed frame's script as one IIFE string. fengari reaches Node's fs and readline-sync only when `process` exists, which it never does in a frame, so those resolve to an empty module; its one unguarded read, FENGARICONF, is defined away. */
export async function frameBundle(): Promise<{ readonly code: string; readonly files: readonly string[] }> {
  const build = await rolldown({
    input: ENTRY,
    platform: "browser",
    logLevel: "warn",
    transform: { define: { "process.env.FENGARICONF": "undefined" } },
    plugins: [
      {
        name: "visual-frame-node-stubs",
        resolveId: (id) => (NODE_ONLY.has(id.replace(/^node:/u, "")) ? `\0stub:${id}` : undefined),
        load: (id) => (id.startsWith("\0stub:") ? "export default {}" : undefined),
      },
    ],
  })
  const { output } = await build.generate({ format: "iife", minify: true })
  await build.close()
  const chunk = output[0]
  return { code: chunk.code.replaceAll("</script", "<\\/script"), files: chunk.moduleIds.filter((id) => !id.startsWith("\0")) }
}
