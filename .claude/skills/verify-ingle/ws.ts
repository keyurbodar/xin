const [url, token, ...frames] = process.argv.slice(2)
if (url === undefined || token === undefined) throw new Error("usage: ws.ts URL TOKEN FRAME_JSON...")
const ws = new WebSocket(url, ["xin", `bearer.${token}`])
const done = Promise.withResolvers<void>()
ws.onopen = () => {
  console.log(`open protocol=${ws.protocol}`)
  for (const frame of frames) ws.send(frame)
  setTimeout(() => ws.close(), Number(process.env.XIN_WS_WAIT_MS ?? 1500))
}
ws.onmessage = (event) => console.log(`< ${String(event.data)}`)
ws.onerror = () => done.reject(new Error("socket error"))
ws.onclose = () => done.resolve()
await done.promise
