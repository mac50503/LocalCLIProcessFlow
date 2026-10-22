import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessError, runProcess } from "../src/index.js";

const fake = join(import.meta.dirname, "fake-cli.mjs");
const base = { command: process.execPath, timeoutMs: 5000, maxStdoutBytes: 1_000_000 };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<ProcessError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProcessError) return error;
    throw error;
  }
  throw new Error("expected the process to fail");
}

describe("runProcess", () => {
  it("passes stdin and captures stdout", async () => {
    const out = await runProcess({ ...base, args: [fake, "structured"], stdin: "hello" });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).structured_output.stdin).toBe("hello");
  });

  it("does not interpret arguments through a shell", async () => {
    const nasty = "a & echo INJECTED; $(echo INJECTED) \"quoted\"";
    const out = await runProcess({ ...base, args: [fake, "structured", nasty], stdin: "" });
    const echoed = JSON.parse(out.stdout).structured_output.echoArgs as string[];
    expect(echoed).toEqual([nasty]);
  });

  it("reports a non-zero exit code and keeps stderr", async () => {
    const out = await runProcess({ ...base, args: [fake, "exit1"] });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("boom");
  });

  it("gives the child only a minimal environment", async () => {
    process.env.LCPF_SECRET = "top-secret";
    try {
      const out = await runProcess({ ...base, args: [fake, "env"] });
      expect(JSON.parse(out.stdout).structured_output).toEqual({ hasSecret: false, hasPath: true });
    } finally {
      delete process.env.LCPF_SECRET;
    }
  });

  it("fails with kind=spawn and ENOENT when the command does not exist", async () => {
    const error = await failure(runProcess({ command: "definitely-not-a-real-command-xyz", args: [], timeoutMs: 5000, maxStdoutBytes: 1000 }));
    expect(error.kind).toBe("spawn");
    expect(error.errno).toBe("ENOENT");
  });

  it("kills a hanging process on timeout", async () => {
    const started = performance.now();
    const error = await failure(runProcess({ ...base, args: [fake, "hang"], timeoutMs: 300 }));
    expect(error.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(4000);
  });

  it("kills the process when the signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const error = await failure(runProcess({ ...base, args: [fake, "hang"], signal: controller.signal }));
    expect(error.kind).toBe("aborted");
  });

  it("does not start when the signal is already aborted", async () => {
    const error = await failure(runProcess({ ...base, args: [fake, "structured"], signal: AbortSignal.abort() }));
    expect(error.kind).toBe("aborted");
  });

  it("stops a process that writes too much output", async () => {
    const error = await failure(runProcess({ ...base, args: [fake, "huge"], maxStdoutBytes: 10_000 }));
    expect(error.kind).toBe("output_too_large");
  });

  it("kills the whole process tree on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcpf-tree-"));
    dirs.push(dir);
    const marker = join(dir, "marker.txt");
    const error = await failure(runProcess({ ...base, args: [fake, `tree:${marker}`], timeoutMs: 500 }));
    expect(error.kind).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  });
});
