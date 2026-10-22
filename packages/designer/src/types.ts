export interface NodeInfo {
  type: string;
  version: number;
  displayName: string;
  category: string;
  permissions: string[];
  configJsonSchema: unknown;
}

export interface WfNode {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export type Workflow = { schemaVersion: number; id: string; name: string; nodes: WfNode[] } & Record<string, unknown>;

export interface WorkflowSummary {
  id: string;
  name: string;
  nodeCount: number;
}

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export interface NodeRun {
  nodeId: string;
  type: string;
  status: "ok" | "stopped" | "error" | "skipped";
  durationMs: number;
  input?: unknown;
  output?: unknown;
  error?: { code: string; message: string };
  logs?: { event: string; data?: Record<string, string | number | boolean> }[];
}

export interface RunResult {
  status: "completed" | "stopped" | "failed";
  durationMs: number;
  output?: unknown;
  stopReason?: string;
  error?: { code: string; message: string; nodeId?: string };
  nodes: NodeRun[];
}
