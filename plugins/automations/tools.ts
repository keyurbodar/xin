import { defineExtension, defineTool, section, type ToolExecutionResult } from "@earendil-works/pi-durable"
import { bool, obj, opt, str } from "@earendil-works/pi-schema"
import { type Context, textResult } from "../../src/kernel/index.ts"
import { AutomationError, type Engine } from "./automations.ts"
import { Project, Prompt, targetSchema, Title, triggersSchema } from "./ops.ts"

export const name = "tool-automations"
export const inject = ["pi", "automations"]

const AUTHORIZATION =
  "Only create, change or trigger automations at the user's explicit request; " +
  "an automation that is already running keeps the authorization it was created with."

const TRIGGERS_HELP =
  "cron has 5 fields, read in tz (IANA). A webhook answers POST at the returned path and appends the body to the " +
  "prompt; a rule collects matching deliveries into one run."

const TARGET_HELP = "fresh: a new thread per run (default). same: this conversation, or threadId, for every run."

export function apply(ctx: Context): void {
  const engine = ctx.automations
  ctx.pi.install(
    defineExtension({
      name: "tool-automations",
      tools: [saveTool(engine), listTool(engine), triggerTool(engine)],
      sections: [section("automations", () => AUTHORIZATION)],
    }),
  )
}

function saveTool(engine: Engine) {
  return defineTool({
    name: "automation_save",
    description:
      "Create an automation, a stored prompt that starts a run whenever one of its triggers fires, or with id change, " +
      "enable, disable or delete one. triggers replaces the whole set.",
    parameters: obj({
      id: opt(str({ minLength: 1, maxLength: 128 })),
      title: opt(Title),
      prompt: opt(Prompt),
      triggers: opt(triggersSchema(TRIGGERS_HELP)),
      target: opt(targetSchema(TARGET_HELP)),
      project: opt(Project),
      enabled: opt(bool()),
      delete: opt(bool({ description: "true deletes the automation and its history." })),
    }),
    replay: "safe",
    execute: (args, api) =>
      runTool(async () => {
        const caller = { conversationId: api.conversationId }
        const { id } = args
        if (id === undefined)
          return engine.create(
            { ...args, title: args.title ?? "", prompt: args.prompt ?? "", triggers: args.triggers ?? [] },
            caller,
            api.now(),
            `auto-call-${api.taskId}`,
          )
        if (args.delete === true) return { id, deleted: await engine.remove(id) }
        return engine.update({ ...args, id }, caller, api.now())
      }),
  })
}

function listTool(engine: Engine) {
  return defineTool({
    name: "automation_list",
    description: "List automations with their triggers, next run and last run.",
    parameters: obj({}),
    replay: "safe",
    execute: () => runTool(async () => ({ automations: await engine.list() })),
  })
}

function triggerTool(engine: Engine) {
  return defineTool({
    name: "automation_trigger",
    description: "Run an automation now, with optional input appended to its prompt.",
    parameters: obj({
      id: str({ minLength: 1, maxLength: 128 }),
      input: opt(str({ minLength: 1, maxLength: 16_384 })),
    }),
    replay: "safe",
    execute: (args, api) => runTool(() => engine.trigger(args.id, args.input, api.now(), `manual:call-${api.taskId}`)),
  })
}

async function runTool(run: () => Promise<unknown>): Promise<ToolExecutionResult> {
  try {
    return textResult(JSON.stringify(await run()))
  } catch (error) {
    if (error instanceof AutomationError)
      return textResult(JSON.stringify({ code: error.code, message: error.message }))
    return textResult(JSON.stringify({ code: "internal_error", message: "The automation operation failed." }))
  }
}
