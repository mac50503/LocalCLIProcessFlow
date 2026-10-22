# Workflow format (schemaVersion 1)

A workflow is one JSON file. Order of execution is the order of `nodes`. The file contains no code and no secrets.

```json
{
  "schemaVersion": 1,
  "id": "jira-story-analyzer",
  "name": "Jira story analyzer",
  "requires": {
    "nodes": { "input.json": 1, "transform.map": 1, "context.files": 1, "ai.cli": 1, "validate.schema": 1, "output.result": 1 },
    "providers": ["claude"]
  },
  "limits": { "nodeTimeoutMs": 120000, "workflowTimeoutMs": 600000, "maxPayloadBytes": 1048576 },
  "nodes": [
    {
      "id": "story",
      "type": "input.json",
      "config": { "schema": { "type": "object", "required": ["key", "description"] } }
    },
    {
      "id": "normalized",
      "type": "transform.map",
      "config": {
        "mapping": {
          "key": "{{ nodes.story.output.key }}",
          "text": "{{ nodes.story.output.description }}"
        }
      }
    },
    {
      "id": "rules",
      "type": "context.files",
      "config": { "paths": ["rules/jira-analysis.md"] }
    },
    {
      "id": "analysis",
      "type": "ai.cli",
      "config": {
        "provider": "claude",
        "instructions": "Analyze the story against the rules and list risks.",
        "input": "{{ nodes.normalized.output }}",
        "contextFrom": ["rules"],
        "outputSchema": {
          "type": "object",
          "required": ["summary", "risks"],
          "properties": {
            "summary": { "type": "string" },
            "risks": { "type": "array", "items": { "type": "string" } }
          }
        },
        "timeoutMs": 90000
      }
    },
    {
      "id": "result",
      "type": "output.result",
      "config": { "value": "{{ nodes.analysis.output }}" }
    }
  ]
}
```

## Fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Format version. The runtime rejects unknown versions. |
| `id`, `name` | Stable identifier (kebab-case) and display name. |
| `requires` | Node types (with minimum versions) and AI providers needed. Checked before running; also the export prerequisites. |
| `limits` | Optional overrides, capped by runtime policy. |
| `nodes[].id` | Unique within the workflow. Used in templates. |
| `nodes[].type` | A registered node type. |
| `nodes[].config` | Validated against that type's `configSchema`. |
| `nodes[].enabled` | Optional, default `true`. A disabled node is `skipped`. |

## Templates

- `{{ input }}` is the workflow input; `{{ nodes.<id>.output.<path> }}` is an earlier node's output; `{{ secret.NAME }}` is a named secret.
- Paths are property and index lookups only (`a.b[0].c`). No expressions, functions or code.
- A value that is exactly one template keeps its type (object, number, ...). A template inside a longer string is converted to text.
- A reference to a missing node, a later node, or an unknown secret is a validation error before any node runs.

## Validation before execution

1. Parse and check `schemaVersion`.
2. Unique node ids; every `type` registered and meeting the `requires` version.
3. Each `config` passes its `configSchema`.
4. All template references resolve to earlier nodes.
5. Declared node permissions are allowed by runtime policy; configured file paths fall within allowlisted roots.

## Export package (Phase 5 preview)

A zip with `manifest.json` (package format version, runtime and node requirements, providers, checksums), `workflow.json`, and a `context/` folder with referenced Markdown files. No secrets, no credentials, no generated source code. The destination machine installs the runtime, configures its own AI CLI, and supplies secrets as environment variables.
