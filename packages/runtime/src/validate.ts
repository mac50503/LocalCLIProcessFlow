import { workflowSchema, type Workflow } from "@lcpf/shared";
import { TemplateError, WorkflowValidationError, type ValidationIssue } from "./errors.js";
import type { NodeRegistry } from "./registry.js";
import { collectRefs, hasTemplates } from "./templates.js";
import type { Limits, RuntimePolicy } from "./types.js";

export interface ValidationContext {
  registry: NodeRegistry;
  policy: RuntimePolicy;
  /** When provided, secrets referenced by the workflow must exist. */
  secret?: (name: string) => string | undefined;
}

export interface ValidatedWorkflow {
  workflow: Workflow;
  limits: Limits;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    const key = String(segment);
    return acc ? `${acc}.${key}` : key;
  }, "");
}

export function validateWorkflow(raw: unknown, ctx: ValidationContext): ValidatedWorkflow {
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((issue) => ({ path: formatPath(issue.path) || "(root)", code: "SCHEMA", message: issue.message }))
    );
  }
  const workflow = parsed.data;
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };

  const indexById = new Map<string, number>();
  workflow.nodes.forEach((node, index) => {
    if (indexById.has(node.id)) add(`nodes[${index}].id`, "DUPLICATE_ID", `Node id "${node.id}" is used more than once`);
    else indexById.set(node.id, index);
  });

  for (const [type, minVersion] of Object.entries(workflow.requires?.nodes ?? {})) {
    const installed = ctx.registry.get(type);
    if (!installed) add(`requires.nodes.${type}`, "NODE_TYPE_MISSING", `Node type "${type}" is not installed`);
    else if (installed.version < minVersion) {
      add(`requires.nodes.${type}`, "NODE_VERSION", `Installed version ${installed.version} of "${type}" is older than required ${minVersion}`);
    }
  }

  workflow.nodes.forEach((node, index) => {
    const base = `nodes[${index}]`;
    const nodeType = ctx.registry.get(node.type);
    if (!nodeType) {
      add(`${base}.type`, "UNKNOWN_NODE_TYPE", `Node type "${node.type}" is not installed`);
      return;
    }

    for (const permission of nodeType.permissions) {
      if (!ctx.policy.allowedPermissions.includes(permission)) {
        add(`${base}.type`, "PERMISSION_DENIED", `Node type "${node.type}" needs permission "${permission}", which runtime policy does not allow`);
      }
    }

    let templated: boolean;
    try {
      templated = hasTemplates(node.config);
    } catch (error) {
      add(`${base}.config`, "TEMPLATE_SYNTAX", error instanceof Error ? error.message : String(error));
      return;
    }

    // Configs with templates are validated after resolution, right before the node runs.
    if (!templated) {
      const result = nodeType.configSchema.safeParse(node.config);
      if (!result.success) {
        for (const issue of result.error.issues) add(formatPath([...`${base}.config`.split("."), ...issue.path]), "CONFIG_INVALID", issue.message);
      }
    }

    if (!node.enabled) return;
    let refs;
    try {
      refs = collectRefs(node.config);
    } catch (error) {
      if (error instanceof TemplateError) add(`${base}.config`, error.code, error.message);
      else throw error;
      return;
    }
    for (const ref of refs) {
      if (ref.root === "nodes") {
        const target = indexById.get(ref.nodeId);
        if (target === undefined) add(`${base}.config`, "UNKNOWN_REFERENCE", `"${ref.expr}" refers to node "${ref.nodeId}", which does not exist`);
        else if (target >= index) add(`${base}.config`, "FORWARD_REFERENCE", `"${ref.expr}" must refer to an earlier node`);
        else if (workflow.nodes[target]?.enabled === false) add(`${base}.config`, "DISABLED_REFERENCE", `"${ref.expr}" refers to disabled node "${ref.nodeId}"`);
      } else if (ref.root === "secret" && ctx.secret && ctx.secret(ref.name) === undefined) {
        add(`${base}.config`, "SECRET_MISSING", `Secret "${ref.name}" is not available`);
      }
    }
  });

  if (issues.length > 0) throw new WorkflowValidationError(issues);

  const ceiling = ctx.policy.limits;
  const requested = workflow.limits ?? {};
  const limits: Limits = {
    nodeTimeoutMs: Math.min(requested.nodeTimeoutMs ?? ceiling.nodeTimeoutMs, ceiling.nodeTimeoutMs),
    workflowTimeoutMs: Math.min(requested.workflowTimeoutMs ?? ceiling.workflowTimeoutMs, ceiling.workflowTimeoutMs),
    maxPayloadBytes: Math.min(requested.maxPayloadBytes ?? ceiling.maxPayloadBytes, ceiling.maxPayloadBytes)
  };
  return { workflow, limits };
}
