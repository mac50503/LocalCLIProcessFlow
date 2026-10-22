import { z } from "zod";
import { NodeError } from "../errors.js";
import { defineNode } from "../types.js";

const MAX_PATTERN = 200;
const MAX_SUBJECT = 100_000;

const configSchema = z
  .object({
    value: z.unknown(),
    operator: z.enum(["equals", "notEquals", "contains", "matches", "exists", "truthy"]),
    expected: z.unknown().optional(),
    flags: z.string().regex(/^[gimsuy]*$/).max(6).optional(),
    onFail: z.enum(["stop", "error"]).default("stop"),
    reason: z.string().max(500).optional()
  })
  .strict();

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function evaluate(config: z.infer<typeof configSchema>): boolean {
  const { value, operator, expected } = config;
  switch (operator) {
    case "equals":
      return same(value, expected);
    case "notEquals":
      return !same(value, expected);
    case "exists":
      return value !== undefined && value !== null;
    case "truthy":
      return Boolean(value);
    case "contains":
      if (typeof value === "string" && typeof expected === "string") return value.includes(expected);
      if (Array.isArray(value)) return value.some((item) => same(item, expected));
      return false;
    case "matches": {
      if (typeof value !== "string" || typeof expected !== "string") {
        throw new NodeError("CONDITION_INVALID", "operator \"matches\" needs a string value and a string pattern");
      }
      if (expected.length > MAX_PATTERN || value.length > MAX_SUBJECT) {
        throw new NodeError("CONDITION_INVALID", "Pattern or value is too long for \"matches\"");
      }
      let regex: RegExp;
      try {
        regex = new RegExp(expected, config.flags?.replace(/[gy]/g, ""));
      } catch {
        throw new NodeError("CONDITION_INVALID", "Invalid regular expression");
      }
      return regex.test(value);
    }
  }
}

export const conditionCheck = defineNode({
  type: "condition.check",
  version: 1,
  displayName: "Check condition",
  category: "condition",
  configSchema,
  permissions: [],
  async execute(ctx) {
    const passed = evaluate(ctx.config);
    if (passed) return { status: "ok", output: { passed: true } };
    const reason = ctx.config.reason ?? `Condition "${ctx.config.operator}" was not met`;
    if (ctx.config.onFail === "error") throw new NodeError("CONDITION_FAILED", reason);
    return { status: "stop", reason, output: { passed: false } };
  }
});
