import { z } from "zod";
import { createDefaultRegistry, defineNode, runWorkflow, validateWorkflow, type Limits, type RunResult, type RuntimePolicy } from "../src/index.js";

export const limits: Limits = { nodeTimeoutMs: 1000, workflowTimeoutMs: 5000, maxPayloadBytes: 10_000 };
export const policy: RuntimePolicy = { limits, allowedPermissions: [] };

export const sleepNode = defineNode({
  type: "test.sleep",
  version: 1,
  displayName: "Sleep",
  category: "transform",
  configSchema: z.object({ ms: z.number() }).strict(),
  permissions: [],
  async execute(ctx) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ctx.config.ms);
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    return { status: "ok", output: { slept: ctx.config.ms } };
  }
});

export const hangNode = defineNode({
  type: "test.hang",
  version: 1,
  displayName: "Hang",
  category: "transform",
  configSchema: z.object({}).strict(),
  permissions: [],
  execute: () => new Promise(() => undefined)
});

export const throwNode = defineNode({
  type: "test.throw",
  version: 1,
  displayName: "Throw",
  category: "transform",
  configSchema: z.object({}).strict(),
  permissions: [],
  async execute() {
    throw new Error("boom with details");
  }
});

export const bigNode = defineNode({
  type: "test.big",
  version: 1,
  displayName: "Big",
  category: "transform",
  configSchema: z.object({}).strict(),
  permissions: [],
  async execute() {
    return { status: "ok", output: "x".repeat(50_000) };
  }
});

export const strictOutputNode = defineNode({
  type: "test.strictOutput",
  version: 1,
  displayName: "Strict output",
  category: "transform",
  configSchema: z.object({}).strict(),
  outputSchema: z.object({ n: z.number() }),
  permissions: [],
  async execute() {
    return { status: "ok", output: { n: "not a number" } as never };
  }
});

export const netNode = defineNode({
  type: "test.net",
  version: 1,
  displayName: "Net",
  category: "integration",
  configSchema: z.object({}).strict(),
  permissions: ["net"],
  async execute() {
    return { status: "ok", output: null };
  }
});

export function testRegistry() {
  const registry = createDefaultRegistry();
  for (const node of [sleepNode, hangNode, throwNode, bigNode, strictOutputNode, netNode]) registry.register(node);
  return registry;
}

export function wf(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: "test-flow", name: "Test", nodes, ...extra };
}

export async function run(
  nodes: unknown[],
  options: { input?: unknown; secrets?: Record<string, string>; signal?: AbortSignal; limits?: Partial<Limits>; captureData?: boolean } = {}
): Promise<RunResult> {
  const registry = testRegistry();
  const secret = (name: string) => options.secrets?.[name];
  const validated = validateWorkflow(wf(nodes), { registry, policy: { ...policy, limits: { ...limits, ...options.limits } }, secret });
  return runWorkflow(validated.workflow, {
    registry,
    limits: validated.limits,
    input: options.input,
    secret,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.captureData ? { captureData: true } : {})
  });
}
