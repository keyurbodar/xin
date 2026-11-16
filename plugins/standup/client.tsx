import { definePlugin } from "@ingle/sdk"

const PROMPT = "/standup "

export default definePlugin({
  name: "standup",
  slots: {
    "palette.command": [
      {
        id: "write-standup",
        title: "Write a standup",
        keywords: ["standup", "status", "update"],
        run: (host) => host.composer.insert(PROMPT),
      },
    ],
    "composer.action": [
      {
        id: "standup",
        title: "Write a standup",
        icon: "calendar",
        run: (host, composer) => composer.insert(PROMPT),
      },
    ],
  },
})
