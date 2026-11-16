import { transformAsync } from "@babel/core"
import { plugin } from "bun"
import solid from "babel-preset-solid"

const renderer = new URL("./universal.ts", import.meta.url).pathname

/** Compiles the client's `.tsx` with Solid's universal output into `universal.ts`'s in-memory tree, for `bun test`. */
plugin({
  name: "solid-jsx",
  setup(build) {
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
