import { transformAsync } from "@babel/core"
import { plugin } from "bun"
import solid from "babel-preset-solid"

const renderer = new URL("./universal.ts", import.meta.url).pathname

const BROWSER_BUILD: Record<string, string> = { "": "solid.js", "web/": "web.js", "store/": "store.js" }

/** Resolves Solid to its browser build whatever conditions `bun test` ran under, and compiles the client's `.tsx` with Solid's universal output into `universal.ts`'s in-memory tree, for `bun test`. */
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\/solid-js\/(web\/|store\/)?dist\/server\.c?js$/ }, ({ path }) => {
      const [, part = ""] = /\/solid-js\/(web\/|store\/)?dist\//.exec(path) ?? []
      const browser = path.replace(/server\.c?js$/, BROWSER_BUILD[part] ?? "")
      return { contents: `export * from ${JSON.stringify(browser)}`, loader: "js" }
    })
    build.onLoad({ filter: /\/src\/.*\.tsx$/ }, async ({ path }) => {
      const compiled = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solid, { generate: "universal", moduleName: renderer }]],
      })
      if (typeof compiled?.code !== "string") throw new Error(`solid-jsx: ${path} compiled to nothing`)
      return { contents: compiled.code, loader: "ts" }
    })
  },
})
