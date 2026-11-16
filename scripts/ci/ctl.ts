import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { instabox } from "./instabox.ts"

const REPO = "keyurbodar/xin"
const NAME = "xin-ci"
const PORT = 8080
const SECRETS = join(process.env.HOME ?? "", ".capy/work/secrets/instabox-ci.env")
const APP = "/data/home/ci/app"
const FILES = ["instabox.ts", "plan.ts", "dispatcher.ts"]

const env = (name: string) => {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(name + " is not set")
  return value
}

function local(): Record<string, string> {
  if (!existsSync(SECRETS)) return {}
  return Object.fromEntries(
    readFileSync(SECRETS, "utf8")
      .split("\n")
      .flatMap((line) =>
        /^([A-Z_]+)=(.*)$/.exec(line) ? [[line.split("=")[0] ?? "", line.slice(line.indexOf("=") + 1)]] : [],
      ),
  )
}

async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      authorization: "Bearer " + env("GH_TOKEN"),
      accept: "application/vnd.github+json",
      "user-agent": "xin-ci",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok)
    throw new Error("github " + method + " " + path + ": " + response.status + " " + (await response.text()))
  return (await response.json()) as T
}

async function deploy() {
  const box = instabox(env("INSTABOX_API_KEY"))
  const saved = local()
  const secret = saved.CI_WEBHOOK_SECRET ?? randomBytes(32).toString("hex")
  const existing = (await box.list()).find((machine) => machine.name === NAME)
  const machine =
    existing?.id ??
    (await box.create({
      name: NAME,
      source: { templateId: "universal" },
      spec: { vcpus: 2, memMiB: 4096 },
      metadata: { "xin-ci": "dispatcher" },
      deleteAfterSeconds: 0,
      autoSuspendAfterSeconds: 0,
    }))
  if (existing !== undefined && existing.state !== "running") await box.start(machine).catch(() => undefined)
  const published = await fetch("https://api.instabox.sh/v1/machines/" + machine + "/ports", {
    method: "POST",
    headers: { "X-API-Key": env("INSTABOX_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ port: PORT, name: "xin-ci", access: "public" }),
  })
  const port = (await published.json()) as { url?: string; publicUrl?: string }
  const url = (port.url ?? port.publicUrl ?? "").replace(/\/$/, "")
  if (url === "") throw new Error("no public URL: " + JSON.stringify(port))
  for (const file of FILES)
    await box.write(machine, APP + "/" + file, readFileSync(join(import.meta.dirname, file), "utf8"))
  const vars = [
    "INSTABOX_API_KEY=" + env("INSTABOX_API_KEY"),
    "CI_STATUS_TOKEN=" + env("CI_STATUS_TOKEN"),
    "CI_WEBHOOK_SECRET=" + secret,
    "CI_PUBLIC_URL=" + url,
    "CI_MACHINE_ID=" + machine,
    "CI_HOME=/data/home/ci",
  ].join("\n")
  await box.write(machine, "/data/home/ci/env", vars + "\n", "0600")
  const unit = [
    "[Unit]",
    "Description=xin CI dispatcher",
    "After=network-online.target",
    "[Service]",
    "User=user",
    "EnvironmentFile=/data/home/ci/env",
    "WorkingDirectory=" + APP,
    "ExecStart=/data/home/.bun/bin/bun " + APP + "/dispatcher.ts",
    "Restart=always",
    "RestartSec=2",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n")
  await box.write(machine, "/data/home/ci/xin-ci.service", unit + "\n")
  const setup = await box.exec(
    machine,
    [
      "set -e",
      '[ -x $HOME/.bun/bin/bun ] && [ "$($HOME/.bun/bin/bun --version)" = 1.4.4 ] || curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4 >/dev/null',
      "sudo cp /data/home/ci/xin-ci.service /etc/systemd/system/xin-ci.service",
      "sudo systemctl daemon-reload",
      "sudo systemctl enable xin-ci >/dev/null 2>&1",
      "sudo systemctl restart xin-ci",
      "sleep 2",
      "systemctl is-active xin-ci",
    ].join("\n"),
    120,
  )
  if (setup.exitCode !== 0) throw new Error("dispatcher setup failed: " + setup.stderr + setup.stdout)
  const config = { url: url + "/github", content_type: "json", secret, insecure_ssl: "0" }
  const hook =
    saved.CI_HOOK_ID === undefined
      ? await gh<{ id: number }>("POST", "/repos/" + REPO + "/hooks", {
          name: "web",
          active: true,
          events: ["push", "pull_request"],
          config,
        })
      : await gh<{ id: number }>("PATCH", "/repos/" + REPO + "/hooks/" + saved.CI_HOOK_ID, {
          events: ["push", "pull_request"],
          config,
        })
  writeFileSync(
    SECRETS,
    ["CI_WEBHOOK_SECRET=" + secret, "CI_URL=" + url, "CI_MACHINE_ID=" + machine, "CI_HOOK_ID=" + hook.id, ""].join(
      "\n",
    ),
    { mode: 0o600 },
  )
  chmodSync(SECRETS, 0o600)
  console.log("dispatcher " + machine + " at " + url + ", webhook " + hook.id)
}

async function call(path: string, body: unknown) {
  const saved = local()
  const response = await fetch((saved.CI_URL ?? "") + path, {
    method: "POST",
    headers: { authorization: "Bearer " + (saved.CI_WEBHOOK_SECRET ?? ""), "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  console.log(response.status, await response.text())
}

const [command, sha, flag] = process.argv.slice(2)
switch (command) {
  case "deploy":
    await deploy()
    break
  case "rerun":
    await call("/rerun", { sha, fresh: flag === "--fresh" })
    break
  case "image":
    await call("/image", { sha })
    break
  case "hook":
    console.log(
      (
        await gh<{ active: boolean }>("PATCH", "/repos/" + REPO + "/hooks/" + local().CI_HOOK_ID, {
          active: sha === "on",
        })
      ).active,
    )
    break
  case "runs":
    console.log(JSON.stringify(await (await fetch((local().CI_URL ?? "") + "/runs.json")).json(), null, 2))
    break
  default:
    console.log("usage: bun scripts/ci/ctl.ts deploy | hook on|off | rerun <sha> [--fresh] | image <sha> | runs")
}
