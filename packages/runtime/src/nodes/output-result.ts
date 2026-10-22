import { z } from "zod";
import { defineNode } from "../types.js";

export const outputResult = defineNode({
  type: "output.result",
  version: 1,
  displayName: "Result",
  category: "output",
  configSchema: z.object({ value: z.unknown() }).strict(),
  permissions: [],
  async execute(ctx) {
    return { status: "ok", output: ctx.config.value ?? null };
  }
});
