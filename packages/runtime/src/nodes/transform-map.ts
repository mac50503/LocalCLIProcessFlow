import { z } from "zod";
import { defineNode } from "../types.js";

export const transformMap = defineNode({
  type: "transform.map",
  version: 1,
  displayName: "Build object",
  category: "transform",
  configSchema: z.object({ values: z.record(z.string(), z.unknown()) }).strict(),
  permissions: [],
  async execute(ctx) {
    return { status: "ok", output: ctx.config.values };
  }
});
