import { describe, expect, it } from "vitest";
import { collectRefs, parseExpression, resolveTemplates } from "../src/templates.js";

const scope = {
  input: { name: "Ana", items: [{ id: 7 }], n: 3 },
  results: { first: { list: ["a", "b"], ok: true } } as Record<string, unknown>,
  secret: (name: string) => (name === "TOKEN" ? "s3cret" : undefined)
};

describe("templates", () => {
  it("keeps the type when the string is exactly one template", () => {
    expect(resolveTemplates("{{ input.n }}", scope)).toBe(3);
    expect(resolveTemplates("{{ nodes.first.output.list }}", scope)).toEqual(["a", "b"]);
    expect(resolveTemplates("{{ nodes.first.output.ok }}", scope)).toBe(true);
  });

  it("converts to text when mixed with literal text", () => {
    expect(resolveTemplates("Hi {{ input.name }} #{{ input.items[0].id }}", scope)).toBe("Hi Ana #7");
    expect(resolveTemplates("x={{ nodes.first.output.list }}", scope)).toBe('x=["a","b"]');
  });

  it("resolves recursively in objects and arrays but not in keys", () => {
    expect(resolveTemplates({ "{{ input.name }}": ["{{ input.name }}", 1] }, scope)).toEqual({ "{{ input.name }}": ["Ana", 1] });
  });

  it("resolves secrets", () => {
    expect(resolveTemplates("Bearer {{ secret.TOKEN }}", scope)).toBe("Bearer s3cret");
  });

  it("fails on unresolved references", () => {
    expect(() => resolveTemplates("{{ input.missing }}", scope)).toThrow(/did not resolve/);
    expect(() => resolveTemplates("{{ input.items[5] }}", scope)).toThrow(/did not resolve/);
    expect(() => resolveTemplates("{{ nodes.nope.output }}", scope)).toThrow(/did not resolve/);
    expect(() => resolveTemplates("{{ secret.OTHER }}", scope)).toThrow(/did not resolve/);
  });

  it("does not read inherited properties", () => {
    expect(() => resolveTemplates("{{ input.toString }}", scope)).toThrow(/did not resolve/);
    expect(() => resolveTemplates("{{ nodes.hasOwnProperty.output }}", scope)).toThrow(/did not resolve/);
  });

  it("rejects forbidden keys and bad syntax", () => {
    const bad = [
      "{{ input.__proto__ }}",
      "{{ input.constructor.name }}",
      "{{ input..a }}",
      "{{ input.a( ) }}",
      "{{ }}",
      "{{ foo.bar }}",
      "{{ nodes.a.value }}",
      "{{ secret.A.b }}",
      "{{ input[01a] }}",
      "oops }}",
      "{{ input.a",
      "{{ 1+1 }}"
    ];
    for (const text of bad) {
      expect(() => resolveTemplates(text, scope), text).toThrow();
    }
  });

  it("collects references with their kind", () => {
    const refs = collectRefs({ a: "{{ input.x }}", b: ["{{ nodes.first.output.list[0] }}", "{{ secret.TOKEN }}"] });
    expect(refs.map((r) => r.root)).toEqual(["input", "nodes", "secret"]);
  });

  it("limits expression length", () => {
    expect(() => parseExpression("input." + "a".repeat(300))).toThrow(/too long/);
  });

  it("does not execute anything inside templates", () => {
    expect(() => resolveTemplates("{{ process.exit() }}", scope)).toThrow();
  });
});
