import { z } from "zod";
import { defineNode } from "../types.js";

export const inputJson = defineNode({
  type: "input.json",
  version: 1,
  displayName: "Run input",
  category: "input",
  configSchema: z.object({}).strict(),
  permissions: [],
  async execute(ctx) {
    return { status: "ok", output: ctx.input };
  }
});
