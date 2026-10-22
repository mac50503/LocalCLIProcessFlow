import { Ajv } from "ajv";
import { z } from "zod";
import { AiError, type AiProvider } from "../ai/types.js";
import { NodeError } from "../errors.js";
import { defineNode } from "../types.js";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

const configSchema = z
  .object({
    provider: z.string().min(1).max(50),
    instructions: z.string().min(1).max(8000),
    input: z.unknown().optional(),
    contextFrom: z.array(z.string()).max(20).default([]),
    outputSchema: z.record(z.string(), z.unknown()),
    model: z.string().max(100).optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
    maxOutputBytes: z.number().int().min(1024).max(5_000_000).default(200_000)
  })
  .strict();

const contextResult = z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })) });

/** Builds the ai.cli node over a fixed set of installed providers. */
export function createAiCliNode(providers: readonly AiProvider[]) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  return defineNode({
    type: "ai.cli",
    version: 1,
    displayName: "AI CLI",
    category: "ai",
    configSchema,
    permissions: ["process"],
    async execute(ctx) {
      const { config } = ctx;
      const provider = byId.get(config.provider);
      if (!provider) throw new AiError("AI_NOT_AVAILABLE", `AI provider "${config.provider}" is not installed in this runtime`);

      let validate;
      try {
        validate = ajv.compile(config.outputSchema);
      } catch (error) {
        throw new NodeError("SCHEMA_INVALID", `Invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`);
      }

      const contextFiles: { path: string; content: string }[] = [];
      for (const id of config.contextFrom) {
        if (!Object.hasOwn(ctx.results, id)) throw new NodeError("CONTEXT_MISSING", `contextFrom refers to "${id}", which has no output`);
        const parsed = contextResult.safeParse(ctx.results[id]);
        if (!parsed.success) throw new NodeError("CONTEXT_INVALID", `Output of "${id}" is not a list of files`);
        contextFiles.push(...parsed.data.files);
      }

      ctx.log("ai.call", { provider: provider.id, contextFiles: contextFiles.length });
      const result = await provider.run(
        {
          instructions: config.instructions,
          payload: config.input,
          contextFiles,
          outputSchema: config.outputSchema,
          ...(config.model ? { model: config.model } : {}),
          timeoutMs: config.timeoutMs,
          maxOutputBytes: config.maxOutputBytes
        },
        ctx.signal
      );
      ctx.log("ai.done", { bytes: result.rawBytes });

      if (!validate(result.json)) {
        const detail = (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`).join("; ");
        throw new AiError("AI_INVALID_JSON", `The AI answer does not match outputSchema: ${detail}`);
      }
      return { status: "ok", output: result.json };
    }
  });
}
