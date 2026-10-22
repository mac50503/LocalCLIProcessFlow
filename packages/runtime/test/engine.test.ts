import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

const input = { id: "in", type: "input.json" };
const out = (value: unknown, id = "out") => ({ id, type: "output.result", config: { value } });

describe("runWorkflow", () => {
  it("passes data between nodes and returns the last output node", async () => {
    const result = await run(
      [
        input,
        { id: "map", type: "transform.map", config: { values: { greeting: "Hi {{ input.name }}", n: "{{ input.n }}" } } },
        out("{{ nodes.map.output }}")
      ],
      { input: { name: "Ana", n: 2 } }
    );
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ greeting: "Hi Ana", n: 2 });
    expect(result.nodes.map((n) => n.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("skips disabled nodes", async () => {
    const result = await run([input, { id: "off", type: "test.throw", enabled: false }, out("{{ nodes.in.output }}")], { input: 5 });
    expect(result.status).toBe("completed");
    expect(result.nodes[1]?.status).toBe("skipped");
    expect(result.output).toBe(5);
  });

  it("stops cleanly when a condition is not met and skips the rest", async () => {
    const result = await run(
      [
        input,
        { id: "cond", type: "condition.check", config: { value: "{{ input.score }}", operator: "equals", expected: 10, reason: "score too low" } },
        out("never")
      ],
      { input: { score: 3 } }
    );
    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("score too low");
    expect(result.nodes.map((n) => n.status)).toEqual(["ok", "stopped", "skipped"]);
    expect(result.output).toBeUndefined();
  });

  it("can turn a failed condition into an error", async () => {
    const result = await run([input, { id: "c", type: "condition.check", config: { value: false, operator: "truthy", onFail: "error" } }]);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "CONDITION_FAILED", nodeId: "c" });
  });

  it("supports regex conditions and rejects invalid patterns", async () => {
    const ok = await run([{ id: "c", type: "condition.check", config: { value: "BUY BTC 100", operator: "matches", expected: "^BUY\\s+\\w+" } }]);
    expect(ok.status).toBe("completed");
    const bad = await run([{ id: "c", type: "condition.check", config: { value: "x", operator: "matches", expected: "(" } }]);
    expect(bad.error?.code).toBe("CONDITION_INVALID");
  });

  it("reports unexpected exceptions as NODE_UNEXPECTED and skips the rest", async () => {
    const result = await run([{ id: "t", type: "test.throw" }, out("x")]);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "NODE_UNEXPECTED", nodeId: "t" });
    expect(result.nodes.map((n) => n.status)).toEqual(["error", "skipped"]);
  });

  it("fails when a template cannot be resolved at run time", async () => {
    const result = await run([out("{{ input.missing }}")], { input: {} });
    expect(result.error?.code).toBe("TEMPLATE_UNRESOLVED");
  });

  it("validates resolved config before running the node", async () => {
    const result = await run([{ id: "s", type: "test.sleep", config: { ms: "{{ input.ms }}" } }], { input: { ms: "slow" } });
    expect(result.error?.code).toBe("CONFIG_INVALID");
  });

  it("times out a node that never settles", async () => {
    const result = await run([{ id: "h", type: "test.hang" }, out("x")], { limits: { nodeTimeoutMs: 50 } });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "NODE_TIMEOUT", nodeId: "h" });
    expect(result.nodes[1]?.status).toBe("skipped");
  });

  it("aborts the signal given to a cooperative node on timeout", async () => {
    const started = performance.now();
    const result = await run([{ id: "s", type: "test.sleep", config: { ms: 5000 } }], { limits: { nodeTimeoutMs: 50 } });
    expect(result.error?.code).toBe("NODE_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("enforces the workflow timeout across nodes", async () => {
    const result = await run(
      [
        { id: "a", type: "test.sleep", config: { ms: 80 } },
        { id: "b", type: "test.sleep", config: { ms: 80 } },
        { id: "c", type: "test.sleep", config: { ms: 80 } }
      ],
      { limits: { nodeTimeoutMs: 1000, workflowTimeoutMs: 150 } }
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("WORKFLOW_TIMEOUT");
  });

  it("cancels the run with an external signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await run([{ id: "h", type: "test.hang" }, out("x")], { signal: controller.signal });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RUN_CANCELLED");
    expect(result.nodes[1]?.status).toBe("skipped");
  });

  it("does not run nodes when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run([input], { signal: controller.signal });
    expect(result.error?.code).toBe("RUN_CANCELLED");
  });

  it("rejects oversized node output", async () => {
    const result = await run([{ id: "b", type: "test.big" }]);
    expect(result.error?.code).toBe("OUTPUT_TOO_LARGE");
  });

  it("rejects oversized run input", async () => {
    const result = await run([input], { input: "x".repeat(20_000) });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INPUT_TOO_LARGE");
    expect(result.nodes[0]?.status).toBe("skipped");
  });

  it("enforces the node output schema", async () => {
    const result = await run([{ id: "s", type: "test.strictOutput" }]);
    expect(result.error?.code).toBe("OUTPUT_INVALID");
  });

  it("validates data with JSON Schema and can stop or fail", async () => {
    const schema = { type: "object", required: ["id"], properties: { id: { type: "number" } }, additionalProperties: false };
    const good = await run([{ id: "v", type: "validate.schema", config: { data: { id: 1 }, schema } }]);
    expect(good.status).toBe("completed");
    const bad = await run([{ id: "v", type: "validate.schema", config: { data: { id: "x" }, schema } }]);
    expect(bad.error?.code).toBe("VALIDATION_FAILED");
    const stop = await run([{ id: "v", type: "validate.schema", config: { data: {}, schema, onInvalid: "stop" } }, out("x")]);
    expect(stop.status).toBe("stopped");
    const broken = await run([{ id: "v", type: "validate.schema", config: { data: {}, schema: { type: "nonsense" } } }]);
    expect(broken.error?.code).toBe("SCHEMA_INVALID");
  });

  it("does not capture data unless requested", async () => {
    const quiet = await run([out("{{ secret.TOKEN }}")], { secrets: { TOKEN: "abc" } });
    expect(JSON.stringify(quiet.nodes)).not.toContain("abc");
    const loud = await run([out("{{ secret.TOKEN }}")], { secrets: { TOKEN: "abc" }, captureData: true });
    expect(loud.nodes[0]?.input).toEqual({ value: "abc" });
  });

  it("passes the run input through unchanged", async () => {
    const result = await run([input, out("{{ nodes.in.output }}")], { input: { a: 1 } });
    expect(result.output).toEqual({ a: 1 });
  });

  it("records per-node timing and start time", async () => {
    const result = await run([{ id: "s", type: "test.sleep", config: { ms: 20 } }]);
    expect(result.nodes[0]?.durationMs).toBeGreaterThanOrEqual(15);
    expect(result.nodes[0]?.startedAt).toBeTruthy();
  });
});
