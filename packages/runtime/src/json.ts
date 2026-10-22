import { NodeError } from "./errors.js";

export interface NormalizeOptions {
  maxBytes: number;
  tooLargeCode: string;
  invalidCode: string;
  label: string;
}

/** Round-trips a value through JSON so only plain, serializable, size-limited data moves between nodes. */
export function normalizeJson(value: unknown, options: NormalizeOptions): unknown {
  let json: string;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch {
    throw new NodeError(options.invalidCode, `${options.label} is not JSON-serializable`);
  }
  if (Buffer.byteLength(json, "utf8") > options.maxBytes) {
    throw new NodeError(options.tooLargeCode, `${options.label} exceeds the limit of ${options.maxBytes} bytes`);
  }
  return JSON.parse(json);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
