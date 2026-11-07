import type { Context } from "../../src/kernel/index.ts"
import { createQuestions, HOME_REQUESTS, homeRequests, listOp, type QuestionsPort, respondOp } from "./questions.ts"

export const name = "questions"
export const inject = ["harness", "ops", "clock", "intake", "threads", "watchdog", "wire"]

export function apply(ctx: Context): void {
  const port: QuestionsPort = {
    harness: ctx.harness,
    intake: ctx.intake,
    threads: ctx.threads,
    watchdog: ctx.watchdog,
    arm: () => ctx.clock.arm(),
    run: (command, actor) => ctx.ops.run(command, actor),
  }
  ctx.provide("questions", createQuestions(port))
  ctx.ops.define(respondOp(port))
  ctx.ops.define(listOp())
  ctx.wire.home("requests", () => homeRequests(ctx.harness, HOME_REQUESTS))
}
