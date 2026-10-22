# Project status and handoff

Last updated: 2026-10-21. Read this first when resuming work.

## What this is

LocalCLIProcessFlow: a local visual orchestrator of **linear** workflows (chain of nodes: transforms, conditions, validation, file/HTTP, AI CLI calls). It reuses AI CLIs already installed on the machine (Claude first, then Codex and Kiro) instead of paid APIs. Designer and runtime are separate; workflows are versioned JSON (`type` + `config` only, no code, no secrets) that can run without the designer.

Design docs: `docs/adr/001-architecture.md`, `docs/node-contract.md`, `docs/workflow-format.md`.

## Decisions already made

- TypeScript on Node 22, npm workspaces: `@lcpf/shared`, `@lcpf/runtime`, `@lcpf/designer`.
- Linear chain only. Designer is served by the runtime on 127.0.0.1 with a bearer token (no Electron).
- Templates: `{{ input.x }}`, `{{ nodes.<id>.output.path }}`, `{{ secret.NAME }}` (no eval). Secrets come only from env `LCPF_SECRET_<NAME>`.
- AI node: provider selector (`claude`, `codex`, `kiro`), `prompt`, `outputSchema` (JSON Schema). No model option: each CLI uses its default model. Advanced (collapsed): `input`, `contextFrom`, `timeoutMs`, `maxOutputBytes`.
- Designer layout is based on the FICO Decision Modeler screenshot: explorer on the left, toolbar on top, linear canvas (start circle -> nodes -> end circle) in the center, "Task" properties panel on the right, status bar at the bottom.

## Done and verified

- Workflow schema, validation, sequential engine, deterministic nodes (`input.json`, `transform.map`, `condition.check`, `validate.schema`, `output.result`), `ai.cli`.
- Process runner (no shell, stdin input, minimal env, timeouts, output caps, process-tree kill verified on Windows).
- Claude adapter: real call verified with `claude -p --output-format json --tools "" --no-session-persistence --strict-mcp-config --system-prompt ... --json-schema ...`.
- Local API (Fastify): nodes, workflows CRUD, validate, run, static UI. Token, Host check, body limit, run cap.
- Designer (React + Vite): workflow list, node palette, canvas with drag reorder, properties form generated from node schemas, validate, run with per-node results. Output schema field validates JSON while typing.
- `start-designer.bat`: installs on first run, builds the UI, generates a token, starts the server and opens the browser.
- Tests: 87 passing, 1 skipped (real Claude test, enabled with `LCPF_REAL_CLAUDE=1`).

## Not verified

- The designer has only been checked by typecheck, build and curl against the server. Browser interaction (drag, forms, run display) was handed to the user to try; collect their feedback first.
- Whether `--tools ""` really prevents Claude from using tools.
- Codex and Kiro: no adapters yet. They appear in the selector but fail with `AI_NOT_AVAILABLE`. Flags in the TelegramTrader project are only leads, not verified.

## How to run

- Double-click `start-designer.bat`, or `npm run build:designer` then `npm run designer`.
- `npm test`, `npm run typecheck`.
- Workflows are saved in `workflows/` next to where the command runs.

## Next steps (suggested order)

1. Get the user's feedback from trying the designer in the browser and fix what they report.
2. Nodes still missing: `context.files`, `output.file` (allowlisted dirs, size limits), `http.request` (allowlist, size limits).
3. Export package: zip with `manifest.json`, `workflow.json`, `context/`; commands `run workflow.json` and `serve`; docs for installing on another machine.
4. Codex and Kiro adapters, after checking their real CLI flags on this machine.
5. Pick the final command name (currently a placeholder `designer` subcommand; ADR says `<cmd>`).

## Gotchas

- Engine node timeout must be above the `ai.cli` `timeoutMs`, or the engine wins the race (`NODE_TIMEOUT` instead of `AI_TIMEOUT`).
- `npm install -D -w` after `npm install -w` can drop earlier deps; verify with `npm ls`.
- Long bash heredocs with quotes can fail; use the Write tool.
- Line-ending warnings (LF to CRLF) on commit are harmless.
