import { NodeError } from "../errors.js";

export type AiErrorCode =
  | "AI_NOT_AVAILABLE"
  | "AI_PROCESS_ERROR"
  | "AI_TIMEOUT"
  | "AI_PROCESS_FAILED"
  | "AI_OUTPUT_TOO_LARGE"
  | "AI_INVALID_JSON"
  | "AI_CANCELLED";

export class AiError extends NodeError {
  constructor(code: AiErrorCode, message: string) {
    super(code, message);
    this.name = "AiError";
  }
}

export interface AiRequest {
  /** Trusted task description from the workflow author. */
  instructions: string;
  /** Untrusted data from earlier nodes. Adapters send it through stdin or files, never the command line. */
  payload: unknown;
  contextFiles: { path: string; content: string }[];
  outputSchema: object;
  model?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface AiResult {
  /** Parsed but unvalidated. The ai.cli node validates it. */
  json: unknown;
  rawBytes: number;
}

export interface AiProvider {
  id: string;
  detect(): Promise<boolean>;
  run(request: AiRequest, signal: AbortSignal): Promise<AiResult>;
}
