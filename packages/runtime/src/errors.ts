export class NodeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "NodeError";
  }
}

export class TemplateError extends Error {
  constructor(
    readonly code: "TEMPLATE_SYNTAX" | "TEMPLATE_UNRESOLVED",
    message: string
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

export function toNodeError(error: unknown): NodeError {
  if (error instanceof NodeError) return error;
  if (error instanceof TemplateError) return new NodeError(error.code, error.message);
  const message = error instanceof Error ? error.message : String(error);
  return new NodeError("NODE_UNEXPECTED", `Unexpected error: ${message.slice(0, 500)}`);
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export class WorkflowValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`Workflow is invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "WorkflowValidationError";
  }
}
