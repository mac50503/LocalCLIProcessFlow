import { Ajv } from "ajv";
import { z } from "zod";
import { AiError, type AiProvider } from "../ai/types.js";
import { NodeError } from "../errors.js";
import { defineNode } from "../types.js";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

export const AI_PROVIDER_IDS = ["claude", "codex", "kiro"] as const;

const configSchema = z
  .object({
    provider: z.enum(AI_PROVIDER_IDS).default("claude").describe("AI CLI installed on this machine. It uses its default model."),
    prompt: z.string().min(1).max(8000).describe("What the AI must do. Trusted text written by the workflow author."),
    outputSchema: z
      .record(z.string(), z.unknown())
      .meta({ strictJson: true })
      .describe('JSON Schema the answer must match, e.g. {"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}'),
    input: z.unknown().optional().meta({ advanced: true }).describe("Data for the AI to process, e.g. {{ input }} or {{ nodes.x.output }}. Sent separately from the prompt."),
    contextFrom: z.array(z.string()).max(20).default([]).meta({ advanced: true }).describe("Ids of earlier nodes whose files are given as context."),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000).meta({ advanced: true }),
    maxOutputBytes: z.number().int().min(1024).max(5_000_000).default(200_000).meta({ advanced: true })
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
          instructions: config.prompt,
          payload: config.input,
          contextFiles,
          outputSchema: config.outputSchema,
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
