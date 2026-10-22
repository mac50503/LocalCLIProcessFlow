import type { Workflow } from "@lcpf/shared";
import { NodeError, toNodeError } from "./errors.js";
import { deepFreeze, normalizeJson } from "./json.js";
import type { NodeRegistry } from "./registry.js";
import { resolveTemplates } from "./templates.js";
import type { AnyNodeType, Limits, NodeRun, NodeResult, RunResult } from "./types.js";

export interface RunOptions {
  registry: NodeRegistry;
  limits: Limits;
  input?: unknown;
  secret?: (name: string) => string | undefined;
  /** Aborts the whole run (reported as RUN_CANCELLED). */
  signal?: AbortSignal;
  /** Stores resolved configs and outputs in node records. Off by default because configs may contain secrets and payloads. */
  captureData?: boolean;
}

const MAX_LOG_ENTRIES = 100;

function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  promise.catch(() => undefined);
  return { promise, dispose: () => listener && signal.removeEventListener("abort", listener) };
}

/** Runs a validated workflow sequentially. It never throws: every failure ends up in the result. */
export async function runWorkflow(workflow: Workflow, options: RunOptions): Promise<RunResult> {
  const { registry, limits } = options;
  const startedAtMs = performance.now();
  const startedAt = new Date().toISOString();
  const deadline = startedAtMs + limits.workflowTimeoutMs;
  const secret = options.secret ?? (() => undefined);
  const runs: NodeRun[] = [];
  const results: Record<string, unknown> = {};
  let lastOutput: { value: unknown } | undefined;
  let status: RunResult["status"] = "completed";
  let stopReason: string | undefined;
  let runError: RunResult["error"];

  const finish = (): RunResult => ({
    status,
    startedAt,
    durationMs: Math.round(performance.now() - startedAtMs),
    ...(lastOutput ? { output: lastOutput.value } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(runError ? { error: runError } : {}),
    nodes: runs
  });

  let input: unknown;
  try {
    input = deepFreeze(
      normalizeJson(options.input, { maxBytes: limits.maxPayloadBytes, tooLargeCode: "INPUT_TOO_LARGE", invalidCode: "INPUT_INVALID", label: "Run input" })
    );
  } catch (error) {
    const nodeError = toNodeError(error);
    status = "failed";
    runError = { code: nodeError.code, message: nodeError.message };
    for (const node of workflow.nodes) runs.push({ nodeId: node.id, type: node.type, status: "skipped", durationMs: 0 });
    return finish();
  }

  let halted = false;
  for (const node of workflow.nodes) {
    const run: NodeRun = { nodeId: node.id, type: node.type, status: "skipped", durationMs: 0 };
    runs.push(run);
    if (halted || !node.enabled) continue;

    const nodeType: AnyNodeType | undefined = registry.get(node.type);
    const nodeStart = performance.now();
    run.startedAt = new Date().toISOString();
    const logs: NonNullable<NodeRun["logs"]> = [];
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const onExternalAbort = (): void => controller.abort(new NodeError("RUN_CANCELLED", "The run was cancelled"));
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const own = abortPromise(controller.signal);

    try {
      if (!nodeType) throw new NodeError("UNKNOWN_NODE_TYPE", `Node type "${node.type}" is not installed`);

      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new NodeError("WORKFLOW_TIMEOUT", `The workflow exceeded ${limits.workflowTimeoutMs} ms`);
      const workflowBound = remaining <= limits.nodeTimeoutMs;
      const timeoutError = workflowBound
        ? new NodeError("WORKFLOW_TIMEOUT", `The workflow exceeded ${limits.workflowTimeoutMs} ms`)
        : new NodeError("NODE_TIMEOUT", `Node "${node.id}" exceeded ${limits.nodeTimeoutMs} ms`);
      timer = setTimeout(() => controller.abort(timeoutError), Math.min(remaining, limits.nodeTimeoutMs));

      const resolved = resolveTemplates(node.config, { input, results, secret });
      if (options.captureData) run.input = resolved;

      const parsed = nodeType.configSchema.safeParse(resolved);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`).join("; ");
        throw new NodeError("CONFIG_INVALID", `Invalid config for "${node.id}": ${detail}`);
      }

      controller.signal.throwIfAborted();

      const execution = nodeType.execute({
        config: parsed.data,
        input,
        results: Object.freeze({ ...results }),
        signal: controller.signal,
        log: (event, data) => {
          if (logs.length < MAX_LOG_ENTRIES) logs.push(data ? { event, data } : { event });
        }
      });
      execution.catch(() => undefined);
      const result: NodeResult<unknown> = await Promise.race([execution, own.promise]);

      let output: unknown;
      if (result.output !== undefined || result.status === "ok") {
        output = normalizeJson(result.output, {
          maxBytes: limits.maxPayloadBytes,
          tooLargeCode: "OUTPUT_TOO_LARGE",
          invalidCode: "OUTPUT_INVALID",
          label: `Output of "${node.id}"`
        });
        if (nodeType.outputSchema) {
          const check = nodeType.outputSchema.safeParse(output);
          if (!check.success) {
            const detail = check.error.issues.map((issue) => `${issue.path.join(".") || "(output)"}: ${issue.message}`).join("; ");
            throw new NodeError("OUTPUT_INVALID", `Output of "${node.id}" does not match its schema: ${detail}`);
          }
        }
        results[node.id] = deepFreeze(output);
        if (options.captureData) run.output = output;
      }

      if (result.status === "stop") {
        run.status = "stopped";
        status = "stopped";
        stopReason = result.reason;
        halted = true;
      } else {
        run.status = "ok";
        if (nodeType.category === "output") {
          lastOutput = { value: output };
        }
      }
    } catch (caught) {
      const final = toNodeError(caught);
      run.status = "error";
      run.error = { code: final.code, message: final.message };
      status = "failed";
      runError = { code: final.code, message: final.message, nodeId: node.id };
      halted = true;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
      own.dispose();
      controller.abort(controller.signal.reason ?? new NodeError("NODE_FINISHED", "Node finished"));
      run.durationMs = Math.round(performance.now() - nodeStart);
      if (logs.length > 0) run.logs = logs;
    }
  }

  return finish();
}
