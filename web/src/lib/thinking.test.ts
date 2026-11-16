import { expect, test } from "bun:test"
import { clampThinking, modelSwitch, type ThinkingLevel } from "./thinking.ts"

const full: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
const standard: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"]
const coarse: readonly ThinkingLevel[] = ["low", "high"]

test("a level the new model lists is kept", () => {
  expect(clampThinking("medium", standard)).toBe("medium")
  expect(clampThinking("max", full)).toBe("max")
})

test("a level the new model lacks drops to the nearest lower one it lists", () => {
  expect(clampThinking("max", standard)).toBe("high")
  expect(clampThinking("xhigh", standard)).toBe("high")
  expect(clampThinking("medium", coarse)).toBe("low")
  expect(clampThinking("max", coarse)).toBe("high")
})

test("with nothing lower listed, the model's first level wins", () => {
  expect(clampThinking("off", coarse)).toBe("low")
  expect(clampThinking("minimal", coarse)).toBe("low")
  expect(clampThinking("high", [])).toBeUndefined()
})

test("a model switch carries the clamped level in the same configure", () => {
  expect(modelSwitch({ provider: "p", modelId: "m", thinking: standard }, "max")).toEqual({
    model: { provider: "p", modelId: "m" },
    thinking: "high",
  })
})

test("a model switch leaves thinking alone when the level is the default or the model has no reasoning", () => {
  expect(modelSwitch({ provider: "p", modelId: "m", thinking: standard }, undefined)).toEqual({
    model: { provider: "p", modelId: "m" },
  })
  expect(modelSwitch({ provider: "p", modelId: "m", thinking: ["off"] }, "high")).toEqual({
    model: { provider: "p", modelId: "m" },
  })
})
