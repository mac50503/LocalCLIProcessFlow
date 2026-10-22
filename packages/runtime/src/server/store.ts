import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_WORKFLOW_BYTES = 1_000_000;

export interface WorkflowSummary {
  id: string;
  name: string;
  nodeCount: number;
}

export class StoreError extends Error {
  constructor(
    readonly code: "INVALID_ID" | "NOT_FOUND" | "TOO_LARGE" | "CORRUPT",
    message: string
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** Workflows as plain JSON files: one `<id>.json` per workflow inside a single directory. */
export class WorkflowStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    if (!ID_PATTERN.test(id)) throw new StoreError("INVALID_ID", "Workflow id must be kebab-case (a-z, 0-9, -)");
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<WorkflowSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: WorkflowSummary[] = [];
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
      const id = file.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      try {
        const data = JSON.parse(await readFile(join(this.dir, file), "utf8")) as { name?: unknown; nodes?: unknown };
        summaries.push({ id, name: typeof data.name === "string" ? data.name : id, nodeCount: Array.isArray(data.nodes) ? data.nodes.length : 0 });
      } catch {
        summaries.push({ id, name: `${id} (unreadable)`, nodeCount: 0 });
      }
    }
    return summaries;
  }

  async read(id: string): Promise<unknown> {
    const path = this.pathFor(id);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StoreError("NOT_FOUND", `Workflow "${id}" does not exist`);
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new StoreError("CORRUPT", `Workflow "${id}" is not valid JSON`);
    }
  }

  async write(id: string, workflow: unknown): Promise<void> {
    const path = this.pathFor(id);
    const text = `${JSON.stringify(workflow, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_WORKFLOW_BYTES) throw new StoreError("TOO_LARGE", "Workflow file is too large");
    await mkdir(this.dir, { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  }

  async remove(id: string): Promise<void> {
    const path = this.pathFor(id);
    try {
      await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StoreError("NOT_FOUND", `Workflow "${id}" does not exist`);
      throw error;
    }
  }
}
