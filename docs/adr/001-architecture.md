# ADR 001: Architecture and stack

Status: Proposed (Phase 1). Project name is provisional.

## Context

LocalCLIProcessFlow is a local, visual orchestrator for **linear** workflows. A user chains nodes (transforms, conditions, file/knowledge context, HTTP calls, AI CLI calls, validation, output) and runs them on their own machine. The AI node reuses CLIs already installed on the machine (Claude first, then Codex and kiro-cli) instead of paid model APIs.

Verified in the development environment (2026-10-21): Node v22.23.2, npm 10.9.8, git 2.56, Claude Code 2.1.220. Codex and kiro-cli were not probed yet.

## Decisions

### 1. TypeScript end to end on Node 22
One language for runtime and designer, shared schemas and types. Adapter and subprocess patterns from the sibling `TelegramTrader` project (`cross-spawn`, `zod`, `pino`) can be ported instead of rewritten. Python is not required because custom nodes are TypeScript modules.

### 2. Three packages (npm workspaces)
- `packages/shared`: workflow and execution-record schemas (zod) used by both sides.
- `packages/runtime`: engine, built-in nodes, AI provider adapters, local HTTP API (Fastify), and the CLI entry point. Has **no dependency** on the designer.
- `packages/designer`: React + Vite UI. Talks to the runtime only over HTTP.

### 3. Designer is served by the runtime
`<cmd> designer` starts the runtime and serves the built UI from the same process on `127.0.0.1`. Exported workflows run with the same runtime and no UI: `<cmd> run workflow.json` or `<cmd> serve`. No Electron in the MVP. The command name is pending.

### 4. Execution order is the array order
A workflow is an ordered `nodes` array. The runtime executes one node at a time and never infers order from topology. The designer may draw arrows, but they are decoration. No branches, parallelism or cycles.

### 5. Node types are installed modules, workflows carry no code
A workflow JSON references `type` + `config` only. Node types are registered in the runtime. An imported workflow cannot run code the machine does not already have. An inline-script node is out of scope for the MVP.

### 6. Data flow uses restricted templates
Nodes reference earlier results with `{{ input.x }}` and `{{ nodes.<id>.output.x }}`. The resolver walks property paths only. There is no `eval` and no function calls. All references are checked before the run starts (the target node must exist and appear earlier in the list).

### 7. AI output is untrusted
The engine validates every AI result against the node's JSON schema before any later node sees it. Deterministic nodes decide whether to continue.

### 8. First provider: Claude
Flags confirmed present in `claude --help` (2.1.220): `-p/--print`, `--output-format json`, `--json-schema`, `--tools ""` (disables all tools), `--system-prompt`, `--model`, `--no-session-persistence`, `--strict-mcp-config`, `--max-budget-usd`, `--setting-sources`, `--disable-slash-commands`, `--safe-mode`.

Not yet verified by an actual call: the JSON envelope shape (the `structured_output` field seen in TelegramTrader) and behavior with stdin input. This is the first task of Phase 3.

Note: `--bare` is **not** usable for subscription logins. Per its help text it reads auth only from `ANTHROPIC_API_KEY` or `apiKeyHelper`, never OAuth or keychain.

Codex and kiro-cli adapters come after the provider contract and Claude tests are stable. The TelegramTrader flags for them are leads to verify, not facts.

### 9. Persistence is plain files
Workflows are JSON files in a workspace folder. No database. Execution history is in memory, with optional per-run JSON logs.

## Security baseline (MVP)

- HTTP binds to `127.0.0.1` only, with a bearer token generated at startup. Required for run endpoints.
- Secrets never live in workflow JSON. Config references them by name (`{{ secret.NAME }}`), resolved from environment variables. Exports contain no secrets.
- File nodes may only access directories in an allowlist of roots; paths are resolved and checked after normalization.
- Limits: input size, output size, per-node timeout, whole-workflow timeout.
- Subprocesses use argument arrays, never a shell. Untrusted text is passed by stdin or file, never concatenated into arguments. The environment passed to children is minimal.
- Logs record node ids, durations and error codes, not payloads, unless debug logging is enabled explicitly.
- No network fallback. If no CLI is available, the AI node fails with a configuration error.

## Risks to verify

- **Process cleanup on Windows.** `child.kill()` may not end a CLI's child processes. Plan: kill the process tree (e.g. `taskkill /T /F`) and test it with a real timeout.
- **Automated use terms.** Each CLI's license and rate limits for unattended use must be checked before long-running or high-volume workflows.
- **Node on target machines.** Exported workflows need a compatible Node runtime installed.

## Out of scope for the MVP

Parallel branches, graph traversal, multi-agent orchestration, continuous triggers (Telegram, file watchers, schedules), XML, vector RAG, marketplace, inline code nodes, multiple providers.

## Alternatives considered

- **Python + FastAPI runtime.** Strong for data work, but splits the stack and cannot reuse existing adapters.
- **React Flow canvas.** Deferred. An ordered, drag-sortable list matches linear execution; React Flow can be added later without changing the workflow format.
- **Electron/Tauri.** Deferred in favor of a local web app.
