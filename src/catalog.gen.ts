import * as p0 from "../plugins/deploy-hook/deployhook.ts"
import * as p1 from "../plugins/failures/index.ts"
import * as p2 from "../plugins/files/index.ts"
import * as p3 from "../plugins/files/tools.ts"
import * as p4 from "../plugins/intake/index.ts"
import * as p5 from "../plugins/jobs/index.ts"
import * as p6 from "../plugins/mcp/index.ts"
import * as p7 from "../plugins/mcp/tools.ts"
import * as p8 from "../plugins/memory/index.ts"
import * as p9 from "../plugins/memory/tools.ts"
import * as p10 from "../plugins/models/index.ts"
import * as p11 from "../plugins/models/tools.ts"
import * as p12 from "../plugins/orchestrator/index.ts"
import * as p13 from "../plugins/orchestrator/tools.ts"
import * as p14 from "../plugins/push/index.ts"
import * as p15 from "../plugins/questions/index.ts"
import * as p16 from "../plugins/questions/tools.ts"
import * as p17 from "../plugins/schedules/index.ts"
import * as p18 from "../plugins/schedules/tools.ts"
import * as p19 from "../plugins/skills/index.ts"
import * as p20 from "../plugins/skills/tools.ts"
import * as p21 from "../plugins/time/index.ts"
import * as p22 from "../plugins/watchdog/index.ts"
import * as p23 from "../plugins/workspace/index.ts"
import type { Row } from "./kernel/layers.ts"
import type { Catalog } from "./kernel/loader.ts"

export const CATALOG: Catalog = {
  "deploy-hook": {
    plugin: p0,
    title: "Deploy hook",
    description: "Deploys a new build by POSTing to a configured hook URL.",
    source: "xin-plugin-deploy-hook@0.1.0",
  },
  failures: {
    plugin: p1,
    title: "Failures",
    description: "Run failures as visible entries.",
    source: "xin-plugin-failures@0.1.0",
  },
  files: {
    plugin: p2,
    title: "Files",
    description: "R2-backed read, write and edit for pi's file tools.",
    source: "xin-plugin-files@0.1.0",
  },
  "tool-files": {
    plugin: p3,
    title: "Files tools",
    description: "The model-facing files tools. Disable to hide them; the files service keeps running.",
    source: "xin-plugin-files@0.1.0",
  },
  intake: {
    plugin: p4,
    title: "Intake",
    description: "Inbound debounce, batch claim and dispatch.",
    source: "xin-plugin-intake@0.1.0",
  },
  jobs: {
    plugin: p5,
    title: "Jobs",
    description: "Slow tools as jobs that report back.",
    source: "xin-plugin-jobs@0.1.0",
  },
  mcp: { plugin: p6, title: "MCP", description: "MCP servers as deferred tools.", source: "xin-plugin-mcp@0.1.0" },
  "tool-mcp": {
    plugin: p7,
    title: "MCP tools",
    description: "The model-facing mcp tools. Disable to hide them; the mcp service keeps running.",
    source: "xin-plugin-mcp@0.1.0",
  },
  memory: {
    plugin: p8,
    title: "Memory",
    description: "Notes with FTS recall and the Dreamer.",
    source: "xin-plugin-memory@0.1.0",
  },
  "tool-memory": {
    plugin: p9,
    title: "Memory tools",
    description: "The model-facing memory tools. Disable to hide them; the memory service keeps running.",
    source: "xin-plugin-memory@0.1.0",
  },
  models: {
    plugin: p10,
    title: "Models",
    description: "Run-time model catalog, credentials and set_model.",
    source: "xin-plugin-models@0.1.0",
  },
  "tool-models": {
    plugin: p11,
    title: "Models tools",
    description: "The model-facing models tools. Disable to hide them; the models service keeps running.",
    source: "xin-plugin-models@0.1.0",
  },
  orchestrator: {
    plugin: p12,
    title: "Orchestrator",
    description: "Coordinator tools and threads.",
    source: "xin-plugin-orchestrator@0.1.0",
  },
  "tool-orchestrator": {
    plugin: p13,
    title: "Orchestrator tools",
    description: "The model-facing orchestrator tools. Disable to hide them; the orchestrator service keeps running.",
    source: "xin-plugin-orchestrator@0.1.0",
  },
  push: {
    plugin: p14,
    title: "Web Push",
    description: "Encrypted pushes when no tab is open.",
    source: "xin-plugin-push@0.1.0",
  },
  questions: {
    plugin: p15,
    title: "Questions",
    description: "ask_user and pending requests.",
    source: "xin-plugin-questions@0.1.0",
  },
  "tool-questions": {
    plugin: p16,
    title: "Questions tools",
    description: "The model-facing questions tools. Disable to hide them; the questions service keeps running.",
    source: "xin-plugin-questions@0.1.0",
  },
  schedules: {
    plugin: p17,
    title: "Schedules",
    description: "RRULE and one-shot schedules.",
    source: "xin-plugin-schedules@0.1.0",
  },
  "tool-schedules": {
    plugin: p18,
    title: "Schedules tools",
    description: "The model-facing schedules tools. Disable to hide them; the schedules service keeps running.",
    source: "xin-plugin-schedules@0.1.0",
  },
  skills: {
    plugin: p19,
    title: "Skills",
    description: "Markdown skills loaded on demand.",
    source: "xin-plugin-skills@0.1.0",
  },
  "tool-skills": {
    plugin: p20,
    title: "Skills tools",
    description: "The model-facing skills tools. Disable to hide them; the skills service keeps running.",
    source: "xin-plugin-skills@0.1.0",
  },
  time: {
    plugin: p21,
    title: "Current time",
    description: "A current_time tool in a configurable timezone.",
    source: "xin-plugin-time@0.1.0",
  },
  watchdog: {
    plugin: p22,
    title: "Watchdog",
    description: "Fails stalled threads and overdue jobs.",
    source: "xin-plugin-watchdog@0.1.0",
  },
  workspace: {
    plugin: p23,
    title: "Workspace",
    description: "Projects and thread documents.",
    source: "xin-plugin-workspace@0.1.0",
  },
}

export const BUNDLES: Readonly<Record<string, readonly Row[]>> = {
  "xin-plugin-deploy-hook": [{ id: "deploy-hook", name: "cordis:deploy-hook" }],
  "xin-plugin-failures": [{ id: "failures", name: "cordis:failures" }],
  "xin-plugin-files": [
    { id: "files", name: "cordis:files" },
    { id: "tool-files", name: "cordis:tool-files" },
  ],
  "xin-plugin-intake": [{ id: "intake", name: "cordis:intake" }],
  "xin-plugin-jobs": [{ id: "jobs", name: "cordis:jobs" }],
  "xin-plugin-mcp": [
    { id: "mcp", name: "cordis:mcp" },
    { id: "tool-mcp", name: "cordis:tool-mcp" },
  ],
  "xin-plugin-memory": [
    { id: "memory", name: "cordis:memory" },
    { id: "tool-memory", name: "cordis:tool-memory" },
  ],
  "xin-plugin-models": [
    { id: "models", name: "cordis:models" },
    { id: "tool-models", name: "cordis:tool-models" },
  ],
  "xin-plugin-orchestrator": [
    { id: "orchestrator", name: "cordis:orchestrator" },
    { id: "tool-orchestrator", name: "cordis:tool-orchestrator" },
  ],
  "xin-plugin-push": [{ id: "push", name: "cordis:push" }],
  "xin-plugin-questions": [
    { id: "questions", name: "cordis:questions" },
    { id: "tool-questions", name: "cordis:tool-questions" },
  ],
  "xin-plugin-schedules": [
    { id: "schedules", name: "cordis:schedules" },
    { id: "tool-schedules", name: "cordis:tool-schedules" },
  ],
  "xin-plugin-skills": [
    { id: "skills", name: "cordis:skills" },
    { id: "tool-skills", name: "cordis:tool-skills" },
  ],
  "xin-plugin-time": [{ id: "time", name: "cordis:time", config: { timezone: "UTC" } }],
  "xin-plugin-watchdog": [{ id: "watchdog", name: "cordis:watchdog" }],
  "xin-plugin-workspace": [{ id: "workspace", name: "cordis:workspace" }],
}
