import { expect, test } from "bun:test"
import { exploreViewOf, pluginAction } from "./routes.ts"

test("a plugin with an update is sent to Updates, never to an install the market would refuse", () => {
  expect(pluginAction("update-available")).toBe("review-update")
  expect(pluginAction("not-installed")).toBe("add")
  expect(pluginAction(undefined)).toBe("add")
  expect(pluginAction("installed")).toBe("installed")
  expect(pluginAction("different-version")).toBe("installed")
  expect(pluginAction("provided")).toBe("installed")
})

test("each plugin, skill and theme path is its own view, and unknown paths fall back to the plugin list", () => {
  expect(exploreViewOf(["plugins", "ingle-plugin-a"])).toEqual({ kind: "plugin", name: "ingle-plugin-a" })
  expect(exploreViewOf(["plugins", "ingle-plugin-b"])).toEqual({ kind: "plugin", name: "ingle-plugin-b" })
  expect(exploreViewOf(["skills", "release-notes"])).toEqual({ kind: "skill", name: "release-notes" })
  expect(exploreViewOf(["themes", "fjord"])).toEqual({ kind: "theme", id: "fjord" })
  expect(exploreViewOf(["skills"])).toEqual({ kind: "list", tab: "skills" })
  expect(exploreViewOf(["plugins", "%E0%A4%A"])).toEqual({ kind: "list", tab: "plugins" })
  expect(exploreViewOf([])).toEqual({ kind: "list", tab: "plugins" })
})
