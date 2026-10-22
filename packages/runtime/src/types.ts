import type { ZodType } from "zod";

export type Permission = "fs:read" | "fs:write" | "net" | "process";

export type NodeCategory = "input" | "transform" | "condition" | "context" | "ai" | "validate" | "integration" | "output";

export interface NodeContext<Config> {
  config: Config;
  input: unknown;
  results: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  log(event: string, data?: Record<string, string | number | boolean>): void;
}

export type NodeResult<Output> = { status: "ok"; output: Output } | { status: "stop"; reason: string; output?: Output };

export interface NodeType<Config = unknown, Output = unknown> {
  type: string;
  version: number;
  displayName: string;
  category: NodeCategory;
  configSchema: ZodType<Config>;
  outputSchema?: ZodType<Output>;
  permissions: readonly Permission[];
  execute(ctx: NodeContext<Config>): Promise<NodeResult<Output>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNodeType = NodeType<any, any>;

export function defineNode<Config, Output>(node: NodeType<Config, Output>): AnyNodeType {
  return node;
}

export interface Limits {
  nodeTimeoutMs: number;
  workflowTimeoutMs: number;
  maxPayloadBytes: number;
}

export interface RuntimePolicy {
  /** Ceilings: a workflow can request lower limits, never higher. */
  limits: Limits;
  allowedPermissions: readonly Permission[];
}

export type NodeRunStatus = "ok" | "stopped" | "error" | "skipped";

export interface NodeRun {
  nodeId: string;
  type: string;
  status: NodeRunStatus;
  startedAt?: string;
  durationMs: number;
  /** Resolved config. Present only when the run captures data. */
  input?: unknown;
  output?: unknown;
  error?: { code: string; message: string };
  logs?: { event: string; data?: Record<string, string | number | boolean> }[];
}

export type RunStatus = "completed" | "stopped" | "failed";

export interface RunResult {
  status: RunStatus;
  startedAt: string;
  durationMs: number;
  /** Output of the last successful node in the "output" category. */
  output?: unknown;
  stopReason?: string;
  error?: { code: string; message: string; nodeId?: string };
  nodes: NodeRun[];
}
