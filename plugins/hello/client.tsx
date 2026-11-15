import { definePlugin } from "@ingle/sdk"

export default definePlugin({
  name: "hello",
  slots: {
    "palette.command": [
      {
        id: "say-hello",
        title: "Say hello",
        keywords: ["hello", "greet"],
        run: (host) => host.composer.insert("/hello "),
      },
    ],
  },
})
