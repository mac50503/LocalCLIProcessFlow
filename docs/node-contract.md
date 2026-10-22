# Node contract

Every node type is a module that exports one `NodeType`. The engine knows nothing about specific nodes.

```ts
interface NodeType<Config, Output> {
  type: string;                      // e.g. "transform.map"
  version: number;                   // bump on breaking config changes
  displayName: string;
  category: "input" | "transform" | "condition" | "context" | "ai" | "validate" | "integration" | "output";
  configSchema: ZodType<Config>;     // validates config; also drives the designer form
  outputSchema?: ZodType<Output>;    // optional; validated by the engine after execute()
  permissions: Permission[];         // declared needs, checked against runtime policy
  execute(ctx: NodeContext<Config>): Promise<NodeResult<Output>>;
}

type Permission = "fs:read" | "fs:write" | "net" | "process";

interface NodeContext<Config> {
  config: Config;                    // templates already resolved, then schema-validated
  input: unknown;                    // the workflow input payload
  results: Readonly<Record<string, unknown>>;  // outputs of earlier nodes by id
  signal: AbortSignal;               // timeout and cancellation
  log(event: string, data?: Record<string, string | number | boolean>): void;
  files: FileAccess;                 // enforces the allowlisted roots
  secrets: SecretResolver;           // reads named secrets from the environment
  providers: ProviderRegistry;       // AI CLI adapters
}

type NodeResult<Output> =
  | { status: "ok"; output: Output }
  | { status: "stop"; reason: string; output?: Output };   // terminal, not an error
```

## Rules

1. Nodes read only `ctx`. No globals, no reading other nodes' state.
2. A thrown `NodeError { code, message }` marks the node `error` and stops the workflow. Unexpected exceptions are wrapped as `NODE_UNEXPECTED`.
3. `stop` ends the workflow cleanly (for example, a failed condition). The final status is `stopped`.
4. The engine, not the node, enforces the timeout, the output size limit, and `outputSchema`.
5. A node must honor `ctx.signal` and release resources (processes, temp files) when aborted.
6. A node that uses a capability without declaring the matching permission fails at validation time.

## AI provider contract

```ts
interface AiProvider {
  id: string;                        // "claude"
  detect(): Promise<boolean>;        // is the CLI installed and runnable?
  run(req: AiRequest, signal: AbortSignal): Promise<AiResult>;
}

interface AiRequest {
  instructions: string;              // the node's `prompt`; no model option, each CLI uses its default model
  payload: unknown;                  // data from earlier nodes, serialized by the adapter
  contextFiles: { path: string; content: string }[];  // already read via FileAccess
  outputSchema: object;              // JSON Schema
  timeoutMs: number;
  maxOutputBytes: number;
}

type AiResult = { json: unknown; rawBytes: number };   // unvalidated JSON
```

Adapters return parsed but **unvalidated** JSON or throw a typed error:
`AI_NOT_AVAILABLE`, `AI_PROCESS_ERROR`, `AI_TIMEOUT`, `AI_PROCESS_FAILED`, `AI_OUTPUT_TOO_LARGE`, `AI_INVALID_JSON`. Schema validation happens once, in the `ai.cli` node, so all providers are checked identically. Adapters own their temp files and remove them in `finally`.

## Execution record (per node)

```ts
interface NodeRun {
  nodeId: string;
  type: string;
  status: "ok" | "stopped" | "error" | "skipped";
  startedAt: string;                 // ISO 8601
  durationMs: number;
  input?: unknown;                   // resolved config summary; omitted unless debug is on
  output?: unknown;
  error?: { code: string; message: string };
}
```

A run ends as `completed`, `stopped` or `failed`. Nodes after the one that stopped or failed are `skipped`.

## MVP built-in nodes

`input.json`, `transform.map`, `condition.check`, `context.files`, `ai.cli`, `validate.schema`, `http.request`, `output.result`, `output.file`.
