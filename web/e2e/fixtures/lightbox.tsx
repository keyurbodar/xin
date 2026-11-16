import "../../src/styles/app.css"
import { For, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { trackMotion } from "../../src/lib/motion.ts"
import { Lightbox, type LightboxItem } from "../../src/components/ui/lightbox.tsx"

function paint(width: number, height: number, hue: number, label: string): string {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")!
  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, `hsl(${hue} 55% 38%)`)
  gradient.addColorStop(1, `hsl(${hue + 40} 50% 18%)`)
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)
  context.strokeStyle = "rgb(255 255 255 / 0.18)"
  for (let x = 0; x < width; x += 80) context.strokeRect(x, 0, 80, height)
  for (let y = 0; y < height; y += 80) context.strokeRect(0, y, width, 80)
  context.fillStyle = "white"
  context.font = `600 ${Math.round(height / 8)}px system-ui`
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText(label, width / 2, height / 2)
  return canvas.toDataURL("image/png")
}

const params = new URLSearchParams(location.search)
const gallery = Number(params.get("count") ?? 0)
const origin = params.get("origin") ?? ""

const painted: LightboxItem[] = [
  { src: paint(2400, 1500, 210, "One"), name: "screenshot.png", size: 215_000, type: "image/png" },
  { src: paint(800, 600, 140, "Two"), name: "diagram.png", size: 64_000, type: "image/png" },
  { src: paint(600, 1200, 20, "Three"), name: "phone.png", size: 98_000, type: "image/png" },
]

const items: LightboxItem[] =
  gallery > 0
    ? Array.from({ length: gallery }, (_, at) => ({ src: `${origin}/e2e/img/${at}.png`, name: `image-${at}.png`, type: "image/png" }))
    : painted

function App() {
  trackMotion()
  const [open, setOpen] = createSignal(false)
  const [index, setIndex] = createSignal(0)
  return (
    <main class="flex gap-3 p-6">
      <For each={items}>
        {(item, at) => (
          <button
            id={`thumb-${at()}`}
            type="button"
            aria-label={`Open ${item.name}`}
            class="h-16 w-24 overflow-hidden rounded-sm border border-line-2"
            onClick={() => {
              setIndex(at())
              setOpen(true)
            }}
          >
            {gallery > 0 ? item.name : <img src={item.src} alt="" class="h-full w-full object-cover" />}
          </button>
        )}
      </For>
      <output id="index">{index()}</output>
      <Lightbox items={items} index={index()} open={open()} onClose={() => setOpen(false)} onIndexChange={setIndex} />
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
