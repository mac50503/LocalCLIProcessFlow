import { TemplateError } from "./errors.js";

type PathSegment = string | number;

export type Ref =
  | { root: "input"; path: PathSegment[]; expr: string }
  | { root: "nodes"; nodeId: string; path: PathSegment[]; expr: string }
  | { root: "secret"; name: string; expr: string };

export interface TemplateScope {
  input: unknown;
  results: Readonly<Record<string, unknown>>;
  secret(name: string): string | undefined;
}

const TEMPLATE = /\{\{([^{}]*)\}\}/g;
const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;
const INDEX = /\[(\d{1,6})\]/y;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const MAX_EXPRESSION_LENGTH = 200;
const MAX_SEGMENTS = 32;
const MAX_DEPTH = 64;

function syntax(message: string): TemplateError {
  return new TemplateError("TEMPLATE_SYNTAX", message);
}

export function parseExpression(raw: string): Ref {
  const expr = raw.trim();
  if (!expr) throw syntax("Empty template expression");
  if (expr.length > MAX_EXPRESSION_LENGTH) throw syntax("Template expression is too long");

  const tokens: PathSegment[] = [];
  let pos = 0;
  while (pos < expr.length) {
    if (tokens.length > 0 && expr[pos] === "[") {
      INDEX.lastIndex = pos;
      const match = INDEX.exec(expr);
      if (!match) throw syntax(`Invalid index in "${expr}"`);
      tokens.push(Number(match[1]));
      pos = INDEX.lastIndex;
      continue;
    }
    if (tokens.length > 0) {
      if (expr[pos] !== ".") throw syntax(`Unexpected character in "${expr}"`);
      pos += 1;
    }
    IDENT.lastIndex = pos;
    const match = IDENT.exec(expr);
    if (!match) throw syntax(`Invalid property name in "${expr}"`);
    tokens.push(match[0]);
    pos = IDENT.lastIndex;
  }
  if (tokens.length > MAX_SEGMENTS) throw syntax("Template path is too deep");
  for (const token of tokens) {
    if (typeof token === "string" && FORBIDDEN.has(token)) throw syntax(`"${token}" is not allowed in templates`);
  }

  const root = tokens[0];
  if (root === "input") return { root: "input", path: tokens.slice(1), expr };
  if (root === "nodes") {
    const nodeId = tokens[1];
    if (typeof nodeId !== "string" || tokens[2] !== "output") {
      throw syntax(`"${expr}" must look like nodes.<id>.output[.path]`);
    }
    return { root: "nodes", nodeId, path: tokens.slice(3), expr };
  }
  if (root === "secret") {
    const name = tokens[1];
    if (tokens.length !== 2 || typeof name !== "string" || !SECRET_NAME.test(name)) {
      throw syntax(`"${expr}" must look like secret.NAME`);
    }
    return { root: "secret", name, expr };
  }
  throw syntax(`"${expr}" must start with input, nodes or secret`);
}

/** Splits a string into literal text and references. Stray "{{" or "}}" is a syntax error. */
function parseString(text: string): (string | Ref)[] {
  const parts: (string | Ref)[] = [];
  let last = 0;
  const checkGap = (gap: string): void => {
    if (gap.includes("{{") || gap.includes("}}")) throw syntax("Unbalanced \"{{\" or \"}}\" in string");
    if (gap) parts.push(gap);
  };
  for (const match of text.matchAll(TEMPLATE)) {
    checkGap(text.slice(last, match.index));
    parts.push(parseExpression(match[1] ?? ""));
    last = match.index + match[0].length;
  }
  checkGap(text.slice(last));
  return parts;
}

function visitStrings(value: unknown, visit: (text: string) => void, depth = 0): void {
  if (depth > MAX_DEPTH) throw syntax("Config is nested too deeply");
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) visitStrings(item, visit, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) visitStrings(item, visit, depth + 1);
}

export function collectRefs(value: unknown): Ref[] {
  const refs: Ref[] = [];
  visitStrings(value, (text) => {
    for (const part of parseString(text)) if (typeof part !== "string") refs.push(part);
  });
  return refs;
}

export function hasTemplates(value: unknown): boolean {
  let found = false;
  visitStrings(value, (text) => {
    if (text.includes("{{") || text.includes("}}")) found = true;
  });
  return found;
}

function unresolved(expr: string): TemplateError {
  return new TemplateError("TEMPLATE_UNRESOLVED", `"${expr}" did not resolve to a value`);
}

function walk(root: unknown, path: PathSegment[], expr: string): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) throw unresolved(expr);
      current = current[segment];
    } else {
      if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) throw unresolved(expr);
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function lookup(ref: Ref, scope: TemplateScope): unknown {
  if (ref.root === "input") return walk(scope.input, ref.path, ref.expr);
  if (ref.root === "nodes") {
    if (!Object.hasOwn(scope.results, ref.nodeId)) throw unresolved(ref.expr);
    return walk(scope.results[ref.nodeId], ref.path, ref.expr);
  }
  const value = scope.secret(ref.name);
  if (value === undefined) throw unresolved(ref.expr);
  return value;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/**
 * Resolves templates in every string value (object keys stay literal).
 * A string that is exactly one template keeps the referenced value's type;
 * a template inside longer text is converted to text.
 */
export function resolveTemplates(value: unknown, scope: TemplateScope, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw syntax("Config is nested too deeply");
  if (typeof value === "string") {
    const parts = parseString(value);
    const only = parts[0];
    if (parts.length === 1 && only !== undefined && typeof only !== "string") return lookup(only, scope);
    return parts.map((part) => (typeof part === "string" ? part : toText(lookup(part, scope)))).join("");
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, scope, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, scope, depth + 1)]));
  }
  return value;
}
