import { describe, expect, it } from "vitest";
import { WorkflowValidationError, validateWorkflow } from "../src/index.js";
import { limits, policy, testRegistry, wf } from "./helpers.js";

function issuesOf(raw: unknown, secret?: (n: string) => string | undefined): string[] {
  try {
    validateWorkflow(raw, { registry: testRegistry(), policy, ...(secret ? { secret } : {}) });
  } catch (error) {
    if (error instanceof WorkflowValidationError) return error.issues.map((i) => i.code);
    throw error;
  }
  return [];
}

const input = { id: "in", type: "input.json" };

describe("validateWorkflow", () => {
  it("accepts a valid workflow and applies defaults", () => {
    const v = validateWorkflow(wf([input, { id: "out", type: "output.result", config: { value: "{{ nodes.in.output }}" } }]), {
      registry: testRegistry(),
      policy
    });
    expect(v.workflow.nodes[0]?.enabled).toBe(true);
    expect(v.limits).toEqual(limits);
  });

  it("rejects schema violations", () => {
    expect(issuesOf({})).toContain("SCHEMA");
    expect(issuesOf(wf([]))).toContain("SCHEMA");
    expect(issuesOf({ ...wf([input]), schemaVersion: 2 })).toContain("SCHEMA");
    expect(issuesOf({ ...wf([input]), extra: true })).toContain("SCHEMA");
    expect(issuesOf(wf([{ id: "bad id", type: "input.json" }]))).toContain("SCHEMA");
  });

  it("rejects duplicate ids and unknown types", () => {
    expect(issuesOf(wf([input, input]))).toContain("DUPLICATE_ID");
    expect(issuesOf(wf([{ id: "a", type: "nope.thing" }]))).toContain("UNKNOWN_NODE_TYPE");
  });

  it("checks required node versions", () => {
    expect(issuesOf(wf([input], { requires: { nodes: { "input.json": 9 } } }))).toContain("NODE_VERSION");
    expect(issuesOf(wf([input], { requires: { nodes: { "missing.node": 1 } } }))).toContain("NODE_TYPE_MISSING");
  });

  it("validates static config against the node schema", () => {
    expect(issuesOf(wf([{ id: "a", type: "test.sleep", config: { ms: "slow" } }]))).toContain("CONFIG_INVALID");
    expect(issuesOf(wf([{ id: "a", type: "test.sleep", config: { ms: 1, extra: 1 } }]))).toContain("CONFIG_INVALID");
  });

  it("rejects references to unknown, later, self or disabled nodes", () => {
    const ref = (id: string) => ({ id: "use", type: "output.result", config: { value: `{{ nodes.${id}.output }}` } });
    expect(issuesOf(wf([input, ref("ghost")]))).toContain("UNKNOWN_REFERENCE");
    expect(issuesOf(wf([ref("later"), { id: "later", type: "input.json" }]))).toContain("FORWARD_REFERENCE");
    expect(issuesOf(wf([input, ref("use")]))).toContain("FORWARD_REFERENCE");
    expect(issuesOf(wf([{ ...input, enabled: false }, ref("in")]))).toContain("DISABLED_REFERENCE");
  });

  it("reports template syntax errors", () => {
    expect(issuesOf(wf([{ id: "a", type: "output.result", config: { value: "{{ input.__proto__ }}" } }]))).toContain("TEMPLATE_SYNTAX");
  });

  it("enforces permissions from runtime policy", () => {
    expect(issuesOf(wf([{ id: "n", type: "test.net" }]))).toContain("PERMISSION_DENIED");
  });

  it("checks secrets only when a resolver is given", () => {
    const flow = wf([{ id: "a", type: "output.result", config: { value: "{{ secret.TOKEN }}" } }]);
    expect(issuesOf(flow)).toEqual([]);
    expect(issuesOf(flow, () => undefined)).toContain("SECRET_MISSING");
    expect(issuesOf(flow, () => "x")).toEqual([]);
  });

  it("clamps requested limits to the runtime ceiling", () => {
    const v = validateWorkflow(wf([input], { limits: { nodeTimeoutMs: 999_999, workflowTimeoutMs: 10, maxPayloadBytes: 5 } }), {
      registry: testRegistry(),
      policy
    });
    expect(v.limits).toEqual({ nodeTimeoutMs: limits.nodeTimeoutMs, workflowTimeoutMs: 10, maxPayloadBytes: 5 });
  });

  it("collects several issues at once", () => {
    expect(issuesOf(wf([input, input, { id: "x", type: "nope.thing" }])).length).toBeGreaterThanOrEqual(2);
  });
});
