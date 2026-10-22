import { Ajv } from "ajv";
import { z } from "zod";
import { NodeError } from "../errors.js";
import { defineNode } from "../types.js";

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });

export const validateSchema = defineNode({
  type: "validate.schema",
  version: 1,
  displayName: "Validate JSON Schema",
  category: "validate",
  configSchema: z
    .object({
      data: z.unknown(),
      schema: z.record(z.string(), z.unknown()),
      onInvalid: z.enum(["error", "stop"]).default("error")
    })
    .strict(),
  permissions: [],
  async execute(ctx) {
    let validate;
    try {
      validate = ajv.compile(ctx.config.schema);
    } catch (error) {
      throw new NodeError("SCHEMA_INVALID", `Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (validate(ctx.config.data)) return { status: "ok", output: ctx.config.data };
    const detail = (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`).join("; ");
    if (ctx.config.onInvalid === "stop") return { status: "stop", reason: `Validation failed: ${detail}` };
    throw new NodeError("VALIDATION_FAILED", `Data does not match the schema: ${detail}`);
  }
});
