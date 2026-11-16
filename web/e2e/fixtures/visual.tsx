import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { BlockPayloads } from "../../src/components/chat/registry.ts"
import { VisualBlock } from "../../src/components/chat/visual-block.tsx"
import { registerBlock, renderBlock } from "../../src/components/chat/blocks.tsx"
import { BUILT_IN_THEMES, DEFAULT_THEME, setTheme } from "../../src/lib/theme.ts"

const themeOf = (id: string | null) => BUILT_IN_THEMES.find((entry) => entry.id === id) ?? DEFAULT_THEME

const DASHBOARD = `local s = ui.state { metric = "p95" }
local data = {
  { region = "us-east", p95 = 182, p99 = 240 },
  { region = "eu-west", p95 = 140, p99 = 210 },
  { region = "ap-south", p95 = 231, p99 = 318 },
  { region = "sa-east", p95 = 198, p99 = 260 },
}
return function()
  return ui.column { gap = 16,
    ui.text { "Latency by region", size = "lg", weight = 600 },
    ui.row { gap = 24, wrap = true,
      ui.stat { value = "188 ms", label = "p95, all regions", delta = "-12%", tone = "success" },
      ui.stat { value = "257 ms", label = "p99, all regions" },
    },
    ui.tabs { options = { "p95", "p99" }, value = s.metric, on_change = function(v) s.metric = v end },
    ui.text { "Showing " .. s.metric, size = "sm", color = "muted" },
    ui.chart { type = "bar", height = 220, unit = "ms",
      x = ui.map(data, function(d) return d.region end),
      series = { { name = s.metric, values = ui.map(data, function(d) return d[s.metric] end) } } },
    ui.canvas { height = 120, draw = function(g, w, h)
      for i = 0, 11 do
        local x = i * w / 12
        g:rect(x + 2, h - (i + 1) * 8, w / 12 - 4, (i + 1) * 8, { fill = ui.series(i % 6 + 1), radius = 3 })
      end
    end },
  }
end`

const SCENE = `return ui.scene { height = 260, draw = function(s)
  s:box { at = { 0, 0.25, 0 }, size = { 2, 0.5, 1 }, color = "accent", roughness = 0.4 }
  s:sphere { at = { 0, 1, 0 }, radius = 0.5, color = "chart3", metal = 0.6 }
  s:grid { size = 6, step = 1 }
end }`

const DITHER = `local tracks = { "Every Second Counts", "Set It and Forget It", "Reactive Meets AI" }
local s = ui.state { track = 1 }
return function()
  return ui.column { gap = 12,
    ui.tabs { options = tracks, value = tracks[s.track], on_change = function(v) for i, t in ipairs(tracks) do if t == v then s.track = i end end end },
    ui.chart { type = "bar", horizontal = true, dither = true, height = 220,
      x = { "QueueSnap", "Liquidity Shepherd", "HealthBeat", "LoopMeter" },
      series = { { name = tracks[s.track], values = { 4.6, 3.9, 3.4, 3.1 }, color = ui.series(s.track) } } },
    ui.chart { type = "area", dither = true, height = 160, x = { "Mon", "Tue", "Wed", "Thu", "Fri" },
      series = { { name = "Submissions", values = { 3, 7, 5, 11, 9 } } } },
  }
end`

const params = new URLSearchParams(location.search)
setTheme(themeOf(params.get("theme")))
registerBlock("tool:show_visual", (call) => <VisualBlock {...call} />)

const [call, setCall] = createSignal<BlockPayloads["tool"]>({
  name: "show_visual",
  callId: "call-1",
  args: {
    title: "Latency",
    script: params.get("fixture") === "scene" ? SCENE : params.get("fixture") === "dither" ? DITHER : DASHBOARD,
  },
  status: "done",
})

declare global {
  interface Window {
    visualHarness: {
      set: (script: string, status: BlockPayloads["tool"]["status"]) => void
      theme: (next: string) => void
      readonly dashboard: string
    }
  }
}

window.visualHarness = {
  set: (script, status) =>
    setCall({ name: "show_visual", callId: "call-1", args: { title: "Latency", script }, status }),
  theme: (next) => setTheme(themeOf(next)),
  dashboard: DASHBOARD,
}

const root = document.getElementById("root")
if (root !== null)
  render(
    () => (
      <main class="mx-auto w-full max-w-[720px] px-4 py-6">
        {renderBlock("tool", {
          get name() {
            return call().name
          },
          get callId() {
            return call().callId
          },
          get args() {
            return call().args
          },
          get status() {
            return call().status
          },
        })}
      </main>
    ),
    root,
  )
