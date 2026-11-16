import { startHarness } from "./harness.ts"
const [fixture, out, width, ...steps] = process.argv.slice(2)
const h = await startHarness()
const p = await h.open(fixture!)
await p.setViewportSize({ width: Number(width), height: Number(width) < 600 ? 844 : 800 })
for (const step of steps) {
  if (step.startsWith("click:")) await p.click(step.slice(6))
  else if (step.startsWith("hover:")) await p.hover(step.slice(6))
  else if (step.startsWith("wait:")) await p.waitForTimeout(Number(step.slice(5)))
  else if (step.startsWith("role:")) await p.getByRole("button", { name: step.slice(5) }).click()
  else if (step.startsWith("type:")) await p.keyboard.type(step.slice(5))
  else if (step.startsWith("key:")) await p.keyboard.press(step.slice(4))
  await p.waitForTimeout(450)
}
await p.screenshot({ path: out! })
await h.close()
