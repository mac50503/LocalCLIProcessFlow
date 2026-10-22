import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { runWorkflow } from "../engine.js";
import { WorkflowValidationError } from "../errors.js";
import type { NodeRegistry } from "../registry.js";
import type { Permission, RuntimePolicy } from "../types.js";
import { validateWorkflow } from "../validate.js";
import { StoreError, WorkflowStore } from "./store.js";

export interface ServerOptions {
  registry: NodeRegistry;
  policy: RuntimePolicy;
  /** Directory holding `<id>.json` workflows. */
  workflowsDir: string;
  /** Built designer UI to serve at `/`. Omit to run API only. */
  uiDir?: string;
  /** Defaults to a random token. */
  token?: string;
  port?: number;
  maxConcurrentRuns?: number;
}

export interface RunningServer {
  app: FastifyInstance;
  token: string;
  url: string;
  close(): Promise<void>;
}

const SECRET_PREFIX = "LCPF_SECRET_";
const runBody = z.object({ workflow: z.unknown(), input: z.unknown().optional(), captureData: z.boolean().optional() }).strict();
const validateBody = z.object({ workflow: z.unknown() }).strict();

function secretFromEnv(name: string): string | undefined {
  return process.env[`${SECRET_PREFIX}${name}`];
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function describeNodes(registry: NodeRegistry) {
  return registry.list().map((node) => {
    let configJsonSchema: unknown = {};
    try {
      configJsonSchema = z.toJSONSchema(node.configSchema, { unrepresentable: "any", io: "input" });
    } catch {
      configJsonSchema = {};
    }
    return {
      type: node.type,
      version: node.version,
      displayName: node.displayName,
      category: node.category,
      permissions: node.permissions,
      configJsonSchema
    };
  });
}

export async function createServer(options: ServerOptions): Promise<RunningServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const store = new WorkflowStore(options.workflowsDir);
  const maxRuns = options.maxConcurrentRuns ?? 2;
  let activeRuns = 0;
  let port = options.port ?? 0;

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply.code(403).send({ error: { code: "BAD_HOST", message: "Unexpected Host header" } });
    if (request.url.startsWith("/api/") && !tokenMatches(request.headers.authorization, token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorkflowValidationError) return reply.code(400).send({ error: { code: "WORKFLOW_INVALID", message: "Workflow is invalid", issues: error.issues } });
    if (error instanceof StoreError) {
      const status = error.code === "NOT_FOUND" ? 404 : 400;
      return reply.code(status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid request body" } });
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = error instanceof Error ? error.message : "Bad request";
      return reply.code(status).send({ error: { code: "BAD_REQUEST", message } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal error" } });
  });

  app.get("/api/nodes", async () => ({ nodes: describeNodes(options.registry) }));

  app.get("/api/workflows", async () => ({ workflows: await store.list() }));

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (request) => ({ workflow: await store.read(request.params.id) }));

  app.put<{ Params: { id: string } }>("/api/workflows/:id", async (request) => {
    const { workflow } = validateBody.parse(request.body);
    await store.write(request.params.id, workflow);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (request) => {
    await store.remove(request.params.id);
    return { ok: true };
  });

  app.post("/api/validate", async (request, reply) => {
    const { workflow } = validateBody.parse(request.body);
    try {
      validateWorkflow(workflow, { registry: options.registry, policy: options.policy, secret: secretFromEnv });
      return { valid: true, issues: [] };
    } catch (error) {
      if (error instanceof WorkflowValidationError) return reply.send({ valid: false, issues: error.issues });
      throw error;
    }
  });

  app.post("/api/run", async (request, reply) => {
    const body = runBody.parse(request.body);
    const validated = validateWorkflow(body.workflow, { registry: options.registry, policy: options.policy, secret: secretFromEnv });
    if (activeRuns >= maxRuns) return reply.code(429).send({ error: { code: "TOO_MANY_RUNS", message: "Too many runs in progress" } });

    activeRuns += 1;
    const controller = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on("close", onClose);
    try {
      const result = await runWorkflow(validated.workflow, {
        registry: options.registry,
        limits: validated.limits,
        input: body.input,
        secret: secretFromEnv,
        signal: controller.signal,
        ...(body.captureData ? { captureData: true } : {})
      });
      return { result };
    } finally {
      activeRuns -= 1;
      reply.raw.off("close", onClose);
    }
  });

  if (options.uiDir && existsSync(options.uiDir)) {
    await app.register(fastifyStatic, { root: options.uiDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Unknown endpoint" } });
      return reply.sendFile("index.html");
    });
  }

  await app.listen({ host: "127.0.0.1", port });
  const address = app.server.address();
  port = typeof address === "object" && address ? address.port : port;

  return { app, token, url: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export const allPermissions: readonly Permission[] = ["fs:read", "fs:write", "net", "process"];
export type { RuntimePolicy };
