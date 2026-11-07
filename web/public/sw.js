self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("push", (event) => {
  const payload = readPayload(event)
  const title = textOf(payload, "title") || textOf(payload, "threadTitle") || "Xin"
  const body = textOf(payload, "body") || textOf(payload, "threadTitle")
  const tag = textOf(payload, "tag")
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      ...(tag === "" ? {} : { tag }),
      data: { url: "/" },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data
  const path = data !== null && typeof data === "object" && typeof data.url === "string" ? data.url : "/"
  event.waitUntil(focusOrOpen(new URL(path, self.location.origin).href))
})

function readPayload(event) {
  if (event.data === null || event.data === undefined) return {}
  try {
    const value = event.data.json()
    return value !== null && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function textOf(payload, key) {
  const value = payload[key]
  return typeof value === "string" ? value : ""
}

async function focusOrOpen(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  for (const client of windows) {
    if (client.url === url) return client.focus()
  }
  const existing = windows[0]
  if (existing !== undefined) return existing.focus()
  return self.clients.openWindow(url)
}
