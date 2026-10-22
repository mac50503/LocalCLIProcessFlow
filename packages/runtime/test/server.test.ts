import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../src/index.js";
import { limits, testRegistry, wf } from "./helpers.js";

let dir: string;
let server: RunningServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lcpf-server-"));
  writeFileSync(join(dir, "ui-index.html"), "x");
  server = await createServer({
    registry: testRegistry(),
    policy: { limits, allowedPermissions: [] },
    workflowsDir: join(dir, "workflows"),
    token: "test-token",
    maxConcurrentRuns: 1
  });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown, token: string | null = "test-token") {
  return fetch(`${server.url}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

const flow = wf([{ id: "in", type: "input.json" }, { id: "out", type: "output.result", config: { value: "{{ nodes.in.output }}" } }]);

describe("local API", () => {
  it("binds to loopback only", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const address = server.app.server.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
  });

  it("requires the bearer token on /api", async () => {
    expect((await call("GET", "/api/nodes", undefined, null)).status).toBe(401);
    expect((await call("GET", "/api/nodes", undefined, "wrong-token")).status).toBe(401);
    expect((await call("GET", "/api/nodes", undefined, "test-token-x")).status).toBe(401);
    expect((await call("GET", "/api/nodes")).status).toBe(200);
  });

  it("rejects unexpected Host headers (DNS rebinding)", async () => {
    const port = Number(new URL(server.url).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/nodes", headers: { host: "evil.example.com", authorization: "Bearer test-token" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("describes node types with a JSON Schema for their config", async () => {
    const { nodes } = (await (await call("GET", "/api/nodes")).json()) as { nodes: { type: string; configJsonSchema: { properties?: Record<string, unknown> } }[] };
    const cond = nodes.find((n) => n.type === "condition.check");
    expect(cond?.configJsonSchema.properties).toHaveProperty("operator");
    expect(nodes.map((n) => n.type)).toContain("input.json");
  });

  it("saves, lists, reads and deletes workflows", async () => {
    expect(((await (await call("GET", "/api/workflows")).json()) as { workflows: unknown[] }).workflows).toEqual([]);
    expect((await call("PUT", "/api/workflows/my-flow", { workflow: flow })).status).toBe(200);
    const list = (await (await call("GET", "/api/workflows")).json()) as { workflows: { id: string; name: string; nodeCount: number }[] };
    expect(list.workflows).toEqual([{ id: "my-flow", name: "Test", nodeCount: 2 }]);
    expect(((await (await call("GET", "/api/workflows/my-flow")).json()) as { workflow: unknown }).workflow).toEqual(flow);
    expect((await call("DELETE", "/api/workflows/my-flow")).status).toBe(200);
    expect((await call("GET", "/api/workflows/my-flow")).status).toBe(404);
    expect((await call("DELETE", "/api/workflows/my-flow")).status).toBe(404);
  });

  it("rejects ids that could escape the workflows directory", async () => {
    for (const id of ["..%2Fsecret", "%2E%2E%2Fsecret", "a%2Fb", "A-Upper", "x.json", "-lead"]) {
      const response = await call("PUT", `/api/workflows/${id}`, { workflow: flow });
      expect(response.status, id).toBe(400);
    }
    expect(existsSync(join(dir, "secret.json"))).toBe(false);
  });

  it("validates workflows and reports every issue", async () => {
    const good = (await (await call("POST", "/api/validate", { workflow: flow })).json()) as { valid: boolean };
    expect(good.valid).toBe(true);
    const bad = (await (await call("POST", "/api/validate", { workflow: wf([{ id: "a", type: "nope.thing" }]) })).json()) as { valid: boolean; issues: { code: string }[] };
    expect(bad.valid).toBe(false);
    expect(bad.issues[0]?.code).toBe("UNKNOWN_NODE_TYPE");
  });

  it("runs a workflow and returns the result", async () => {
    const response = await call("POST", "/api/run", { workflow: flow, input: { hello: "world" } });
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as { result: { status: string; output: unknown } };
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ hello: "world" });
  });

  it("refuses to run an invalid workflow with structured issues", async () => {
    const response = await call("POST", "/api/run", { workflow: wf([{ id: "a", type: "nope.thing" }]) });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; issues: unknown[] } };
    expect(body.error.code).toBe("WORKFLOW_INVALID");
    expect(body.error.issues.length).toBeGreaterThan(0);
  });

  it("reads secrets only from LCPF_SECRET_ variables", async () => {
    const secretFlow = wf([{ id: "out", type: "output.result", config: { value: "{{ secret.DEMO }}" } }]);
    process.env.DEMO = "should-not-be-readable";
    try {
      const missing = await call("POST", "/api/validate", { workflow: secretFlow });
      expect(((await missing.json()) as { issues: { code: string }[] }).issues[0]?.code).toBe("SECRET_MISSING");
      process.env.LCPF_SECRET_DEMO = "ok-value";
      const run = await call("POST", "/api/run", { workflow: secretFlow });
      expect(((await run.json()) as { result: { output: unknown } }).result.output).toBe("ok-value");
    } finally {
      delete process.env.DEMO;
      delete process.env.LCPF_SECRET_DEMO;
    }
  });

  it("limits concurrent runs", async () => {
    const slow = wf([{ id: "s", type: "test.sleep", config: { ms: 400 } }]);
    const first = call("POST", "/api/run", { workflow: slow });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await call("POST", "/api/run", { workflow: slow });
    expect(second.status).toBe(429);
    expect((await first).status).toBe(200);
  });

  it("does not expose captured data by default", async () => {
    const response = await call("POST", "/api/run", { workflow: flow, input: { secretish: "abc" } });
    const { result } = (await response.json()) as { result: { nodes: { input?: unknown; output?: unknown }[] } };
    expect(result.nodes.every((n) => n.input === undefined && n.output === undefined)).toBe(true);
  });

  it("returns a clean error for malformed bodies and never leaks internals", async () => {
    const bad = await call("POST", "/api/run", { nope: true });
    expect(bad.status).toBe(400);
    const text = await (await fetch(`${server.url}/api/run`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: "{not json" })).text();
    expect(text).not.toMatch(/at .*\.ts/);
  });

  it("returns 404 JSON for unknown API paths", async () => {
    const response = await call("GET", "/api/unknown");
    expect(response.status).toBe(404);
  });
});

describe("local API serving the UI", () => {
  it("serves static files without a token and falls back to index.html", async () => {
    const uiDir = join(dir, "ui");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(join(uiDir, "index.html"), "<html>designer</html>");
    const ui = await createServer({ registry: testRegistry(), policy: { limits, allowedPermissions: [] }, workflowsDir: join(dir, "w2"), uiDir, token: "t" });
    try {
      const root = await fetch(`${ui.url}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("designer");
      const deep = await fetch(`${ui.url}/some/route`);
      expect(await deep.text()).toContain("designer");
      expect((await fetch(`${ui.url}/api/nodes`)).status).toBe(401);
      expect((await fetch(`${ui.url}/api/nope`, { headers: { authorization: "Bearer t" } })).status).toBe(404);
    } finally {
      await ui.close();
    }
  });
});
