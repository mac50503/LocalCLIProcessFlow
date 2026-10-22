import type { Issue, NodeInfo, RunResult, Workflow, WorkflowSummary } from "./types";

const TOKEN_KEY = "lcpf-token";

function readToken(): string | null {
  const match = /token=([\w-]+)/.exec(window.location.hash);
  if (match?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, match[1]);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

const token = readToken();

export const hasToken = token !== null;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues: Issue[] = []
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${token ?? ""}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw new ApiError("NETWORK", "Cannot reach the runtime. Is it still running?");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string; issues?: Issue[] } } | null)?.error;
    throw new ApiError(error?.code ?? `HTTP_${response.status}`, error?.message ?? `Request failed (${response.status})`, error?.issues ?? []);
  }
  return data as T;
}

export const api = {
  nodes: () => request<{ nodes: NodeInfo[] }>("GET", "/api/nodes").then((r) => r.nodes),
  list: () => request<{ workflows: WorkflowSummary[] }>("GET", "/api/workflows").then((r) => r.workflows),
  read: (id: string) => request<{ workflow: Workflow }>("GET", `/api/workflows/${encodeURIComponent(id)}`).then((r) => r.workflow),
  save: (id: string, workflow: Workflow) => request<{ ok: true }>("PUT", `/api/workflows/${encodeURIComponent(id)}`, { workflow }),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/workflows/${encodeURIComponent(id)}`),
  validate: (workflow: Workflow) => request<{ valid: boolean; issues: Issue[] }>("POST", "/api/validate", { workflow }),
  run: (workflow: Workflow, input: unknown, captureData: boolean) =>
    request<{ result: RunResult }>("POST", "/api/run", { workflow, input, captureData }).then((r) => r.result)
};
