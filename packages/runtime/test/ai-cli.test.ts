import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAiCliNode, createClaudeProvider, createDefaultRegistry, defineNode, runWorkflow, validateWorkflow, type AiProvider } from "../src/index.js";
import { limits as baseLimits, wf } from "./helpers.js";

// The engine node timeout must be above the AI timeoutMs, otherwise the engine wins the race.
const limits = { ...baseLimits, nodeTimeoutMs: 20_000, workflowTimeoutMs: 60_000 };

const fake = join(import.meta.dirname, "fake-cli.mjs");

function setup(provider: AiProvider) {
  const registry = createDefaultRegistry().register(createAiCliNode([provider]));
  registry.register(
    defineNode({
      type: "test.files",
      version: 1,
      displayName: "Files",
      category: "context",
      configSchema: z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })) }).strict(),
      permissions: [],
      async execute(ctx) {
        return { status: "ok", output: { files: ctx.config.files } };
      }
    })
  );
  return registry;
}

async function run(provider: AiProvider, nodes: unknown[], input?: unknown) {
  const registry = setup(provider);
  const validated = validateWorkflow(wf(nodes), { registry, policy: { limits, allowedPermissions: ["process"] } });
  return runWorkflow(validated.workflow, { registry, limits: validated.limits, input });
}

const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
const ai = (config: Record<string, unknown> = {}) => ({
  id: "ai",
  type: "ai.cli",
  config: { provider: "claude", instructions: "Do it", outputSchema: schema, timeoutMs: 5000, ...config }
});
const fakeProvider = (mode: string) => createClaudeProvider({ command: process.execPath, baseArgs: [fake, mode] });

describe("ai.cli node", () => {
  it("returns validated JSON from the provider", async () => {
    const result = await run(fakeProvider("structured"), [ai({ input: "{{ input }}" }), { id: "out", type: "output.result", config: { value: "{{ nodes.ai.output.ok }}" } }], { text: "hi" });
    expect(result.status).toBe("completed");
    expect(result.output).toBe(true);
  });

  it("fails with AI_INVALID_JSON when the answer does not match outputSchema", async () => {
    const strict = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } };
    const result = await run(fakeProvider("structured"), [ai({ outputSchema: strict })]);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "AI_INVALID_JSON", nodeId: "ai" });
  });

  it("fails when the provider is not installed in the runtime", async () => {
    const result = await run(fakeProvider("structured"), [ai({ provider: "codex" })]);
    expect(result.error?.code).toBe("AI_NOT_AVAILABLE");
  });

  it("propagates timeouts as AI_TIMEOUT", async () => {
    const result = await run(fakeProvider("hang"), [ai({ timeoutMs: 1000 })]);
    expect(result.error?.code).toBe("AI_TIMEOUT");
  });

  it("propagates a process failure", async () => {
    const result = await run(fakeProvider("exit1"), [ai()]);
    expect(result.error?.code).toBe("AI_PROCESS_FAILED");
  });

  it("passes context files from an earlier node", async () => {
    const result = await run(fakeProvider("structured"), [
      { id: "rules", type: "test.files", config: { files: [{ path: "r.md", content: "rule one" }] } },
      ai({ contextFrom: ["rules"] })
    ]);
    expect(result.status).toBe("completed");
  });

  it("rejects contextFrom pointing to a node without files", async () => {
    const result = await run(fakeProvider("structured"), [{ id: "in", type: "input.json" }, ai({ contextFrom: ["in"] })], { a: 1 });
    expect(result.error?.code).toBe("CONTEXT_INVALID");
  });

  it("rejects a broken outputSchema before calling the CLI", async () => {
    const result = await run(fakeProvider("structured"), [ai({ outputSchema: { type: "nonsense" } })]);
    expect(result.error?.code).toBe("SCHEMA_INVALID");
  });

  it("is blocked by validation when runtime policy does not allow process", () => {
    const registry = setup(fakeProvider("structured"));
    expect(() => validateWorkflow(wf([ai()]), { registry, policy: { limits, allowedPermissions: [] } })).toThrow(/permission "process"/);
  });
});
