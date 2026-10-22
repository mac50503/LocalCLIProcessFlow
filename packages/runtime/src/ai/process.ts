import { spawn as nodeSpawn } from "node:child_process";
import spawn from "cross-spawn";

export type ProcessFailure = "spawn" | "timeout" | "aborted" | "output_too_large";

export class ProcessError extends Error {
  constructor(
    readonly kind: ProcessFailure,
    message: string,
    readonly errno?: string
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Extra variables on top of the minimal base environment. */
  env?: Record<string, string>;
}

export interface ProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const BASE_ENV_KEYS = [
  "PATH", "PATHEXT", "SystemRoot", "ComSpec", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "XDG_CONFIG_HOME", "XDG_DATA_HOME"
];

export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return fallback();
  if (process.platform === "win32") {
    const killer = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", fallback);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    fallback();
  }
}

/**
 * Runs a command without a shell. Input goes through stdin, never through the command line.
 * The whole process tree is killed on timeout, abort or output overflow.
 */
export function runProcess(request: ProcessRequest): Promise<ProcessOutput> {
  const maxStderr = request.maxStderrBytes ?? 64 * 1024;
  return new Promise<ProcessOutput>((resolve, reject) => {
    if (request.signal?.aborted) return reject(new ProcessError("aborted", "The process was cancelled before starting"));

    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: minimalEnv(request.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ProcessError | undefined;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const fail = (error: ProcessError): void => {
      if (failure) return;
      failure = error;
      killTree(child.pid, () => child.kill("SIGKILL"));
    };
    const onAbort = (): void => fail(new ProcessError("aborted", "The process was cancelled"));
    const timer = setTimeout(() => fail(new ProcessError("timeout", `The process exceeded ${request.timeoutMs} ms`)), request.timeoutMs);
    request.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxStdoutBytes) return fail(new ProcessError("output_too_large", `Output exceeds ${request.maxStdoutBytes} bytes`));
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxStderr) return;
      const room = maxStderr - stderrBytes;
      stderr.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      stderrBytes += Math.min(chunk.length, room);
    });

    child.on("error", (error) => {
      failure ??= new ProcessError("spawn", `Could not start "${request.command}": ${error.message}`, (error as NodeJS.ErrnoException).code);
      settle(() => reject(failure));
    });
    child.on("close", (exitCode) => {
      settle(() => {
        if (failure) return reject(failure);
        resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
    });

    // A child that exits without reading stdin raises EPIPE; the exit code already tells the story.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(request.stdin ?? "");
  });
}
