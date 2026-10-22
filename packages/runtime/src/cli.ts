import { resolve } from "node:path";
import { createClaudeProvider } from "./ai/claude.js";
import { createAiCliNode } from "./nodes/ai-cli.js";
import { createDefaultRegistry } from "./nodes/index.js";
import { allPermissions, createServer } from "./server/app.js";

const USAGE = "Usage: designer [--workflows <dir>] [--ui <dir>] [--port <n>]  (env: LCPF_TOKEN, LCPF_PORT)";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "designer") {
    console.error(USAGE);
    process.exit(1);
  }

  const registry = createDefaultRegistry().register(createAiCliNode([createClaudeProvider()]));
  const port = Number(option(args, "--port") ?? process.env.LCPF_PORT ?? 0);
  const uiDir = option(args, "--ui");

  const server = await createServer({
    registry,
    policy: {
      limits: { nodeTimeoutMs: 10 * 60_000, workflowTimeoutMs: 30 * 60_000, maxPayloadBytes: 5_000_000 },
      allowedPermissions: allPermissions
    },
    workflowsDir: resolve(option(args, "--workflows") ?? "workflows"),
    ...(uiDir ? { uiDir: resolve(uiDir) } : {}),
    ...(process.env.LCPF_TOKEN ? { token: process.env.LCPF_TOKEN } : {}),
    port
  });

  console.log(`Designer running at ${server.url}/#token=${server.token}`);
  console.log("Press Ctrl+C to stop.");

  const stop = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
