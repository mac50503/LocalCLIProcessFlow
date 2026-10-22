import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, hasToken } from "./api";
import { JsonField, SchemaForm } from "./SchemaForm";
import type { Issue, NodeInfo, RunResult, WfNode, Workflow, WorkflowSummary } from "./types";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function newWorkflow(id: string, name: string): Workflow {
  return { schemaVersion: 1, id, name, nodes: [] };
}

function uniqueNodeId(workflow: Workflow, type: string): string {
  const base = type.replace(/\./g, "_");
  const used = new Set(workflow.nodes.map((node) => node.id));
  let n = 1;
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
}

export function App() {
  const [nodeTypes, setNodeTypes] = useState<NodeInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WfNode | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runInput, setRunInput] = useState("{}");
  const [captureData, setCaptureData] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [newId, setNewId] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const dirty = workflow !== null && JSON.stringify(workflow) !== savedJson;
  const selected = workflow?.nodes.find((node) => node.id === selectedId) ?? null;
  const infoByType = useMemo(() => new Map(nodeTypes.map((info) => [info.type, info])), [nodeTypes]);
  const runByNode = useMemo(() => new Map((result?.nodes ?? []).map((run) => [run.nodeId, run])), [result]);
  const draftDirty = selected !== null && draft !== null && JSON.stringify(selected) !== JSON.stringify(draft);

  const refreshList = useCallback(async () => setWorkflows(await api.list()), []);

  useEffect(() => {
    if (!hasToken) return;
    Promise.all([api.nodes(), api.list()])
      .then(([nodes, list]) => {
        setNodeTypes(nodes);
        setWorkflows(list);
      })
      .catch((error) => setStatus(errorText(error)));
  }, []);

  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : null);
  }, [selected]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!hasToken) {
    return (
      <div className="center-message">
        <h2>Session token missing</h2>
        <p>Open the designer with the link printed by the runtime (it ends with <code>#token=...</code>).</p>
      </div>
    );
  }

  const guardUnsaved = (): boolean => !dirty || window.confirm("You have unsaved changes. Discard them?");

  const open = async (id: string): Promise<void> => {
    if (!guardUnsaved()) return;
    try {
      const loaded = await api.read(id);
      setWorkflow(loaded);
      setSavedJson(JSON.stringify(loaded));
      setSelectedId(null);
      setIssues([]);
      setResult(null);
      setStatus(`Opened ${id}`);
    } catch (error) {
      setStatus(errorText(error));
    }
  };

  const create = (): void => {
    const id = newId.trim();
    if (!ID_PATTERN.test(id)) return setStatus("Id must be lowercase letters, digits and dashes");
    if (!guardUnsaved()) return;
    const created = newWorkflow(id, id);
    setWorkflow(created);
    setSavedJson("");
    setSelectedId(null);
    setIssues([]);
    setResult(null);
    setNewId("");
  };

  const update = (change: (nodes: WfNode[]) => WfNode[]): void => {
    setWorkflow((current) => (current ? { ...current, nodes: change(current.nodes) } : current));
    setResult(null);
  };

  const addNode = (info: NodeInfo): void => {
    if (!workflow) return setStatus("Open or create a workflow first");
    const node: WfNode = { id: uniqueNodeId(workflow, info.type), type: info.type, enabled: true, config: {} };
    const at = selectedId ? workflow.nodes.findIndex((n) => n.id === selectedId) + 1 : workflow.nodes.length;
    update((nodes) => [...nodes.slice(0, at), node, ...nodes.slice(at)]);
    setSelectedId(node.id);
  };

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= (workflow?.nodes.length ?? 0) || from === to) return;
    update((nodes) => {
      const copy = [...nodes];
      const [item] = copy.splice(from, 1);
      if (item) copy.splice(to, 0, item);
      return copy;
    });
  };

  const removeSelected = (): void => {
    if (!selectedId) return;
    update((nodes) => nodes.filter((node) => node.id !== selectedId));
    setSelectedId(null);
  };

  const apply = (): void => {
    if (!draft || !selected || !workflow) return;
    const clash = workflow.nodes.some((node) => node.id === draft.id && node.id !== selected.id);
    if (clash) return setStatus(`Id "${draft.id}" is already used`);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(draft.id)) return setStatus("Node id must start with a letter and use letters, digits, _ or -");
    update((nodes) => nodes.map((node) => (node.id === selected.id ? draft : node)));
    setSelectedId(draft.id);
    setStatus("Applied");
  };

  const guarded = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setStatus(label);
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.issues.length > 0) setIssues(error.issues);
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    guarded("Saving...", async () => {
      if (!workflow) return;
      await api.save(workflow.id, workflow);
      setSavedJson(JSON.stringify(workflow));
      await refreshList();
      setStatus(`Saved ${workflow.id}`);
    });

  const validate = (): Promise<void> =>
    guarded("Validating...", async () => {
      if (!workflow) return;
      const outcome = await api.validate(workflow);
      setIssues(outcome.issues);
      setStatus(outcome.valid ? "Workflow is valid" : `${outcome.issues.length} problem(s) found`);
    });

  const run = (): Promise<void> =>
    guarded("Running...", async () => {
      if (!workflow) return;
      let input: unknown;
      try {
        input = JSON.parse(runInput);
      } catch {
        return setStatus("Run input is not valid JSON");
      }
      setIssues([]);
      const outcome = await api.run(workflow, input, captureData);
      setResult(outcome);
      setStatus(`Run ${outcome.status} in ${outcome.durationMs} ms`);
    });

  const deleteWorkflow = async (): Promise<void> => {
    if (!workflow || !window.confirm(`Delete "${workflow.id}" permanently?`)) return;
    try {
      await api.remove(workflow.id);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "NOT_FOUND")) return setStatus(errorText(error));
    }
    setWorkflow(null);
    setSelectedId(null);
    await refreshList();
  };

  const categories = [...new Set(nodeTypes.map((info) => info.category))];
  const draftInfo = draft ? infoByType.get(draft.type) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <strong>LocalCLIProcessFlow</strong>
        <span className="crumb">{workflow ? `${workflow.name}${dirty ? " *" : ""}` : "No workflow open"}</span>
      </header>

      <div className="toolbar">
        <button disabled={!workflow || !dirty || busy} onClick={save}>Save</button>
        <button disabled={!workflow || busy} onClick={validate}>Validate</button>
        <button className="primary" disabled={!workflow || busy || workflow.nodes.length === 0} onClick={run}>Run</button>
        <span className="sep" />
        <button disabled={!selectedId} onClick={() => move(workflow?.nodes.findIndex((n) => n.id === selectedId) ?? 0, (workflow?.nodes.findIndex((n) => n.id === selectedId) ?? 0) - 1)}>Move left</button>
        <button disabled={!selectedId} onClick={() => move(workflow?.nodes.findIndex((n) => n.id === selectedId) ?? 0, (workflow?.nodes.findIndex((n) => n.id === selectedId) ?? 0) + 1)}>Move right</button>
        <button disabled={!selectedId} onClick={removeSelected}>Delete node</button>
        <span className="sep" />
        <button disabled={!workflow} onClick={deleteWorkflow}>Delete workflow</button>
      </div>

      <div className="body">
        <aside className="explorer">
          <h3>Workflows</h3>
          <ul>
            {workflows.map((item) => (
              <li key={item.id} className={workflow?.id === item.id ? "active" : ""} onClick={() => open(item.id)}>
                {item.name} <small>({item.nodeCount})</small>
              </li>
            ))}
            {workflows.length === 0 && <li className="muted">None saved yet</li>}
          </ul>
          <div className="newrow">
            <input placeholder="new-workflow-id" value={newId} onChange={(event) => setNewId(event.target.value)} onKeyDown={(event) => event.key === "Enter" && create()} />
            <button onClick={create}>New</button>
          </div>

          <h3>Add node</h3>
          {categories.map((category) => (
            <div key={category}>
              <div className="category">{category}</div>
              <ul>
                {nodeTypes.filter((info) => info.category === category).map((info) => (
                  <li key={info.type} title={info.type} onClick={() => addNode(info)}>
                    + {info.displayName}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        <main className="canvas-area">
          {!workflow ? (
            <div className="empty">Pick a workflow on the left or create a new one.</div>
          ) : (
            <>
              <div className="wf-title">
                <input value={workflow.name} onChange={(event) => setWorkflow({ ...workflow, name: event.target.value })} />
              </div>
              <div className="canvas" onClick={() => setSelectedId(null)}>
                <div className="chain">
                  <div className="terminal" />
                  {workflow.nodes.map((node, index) => {
                    const info = infoByType.get(node.type);
                    const nodeRun = runByNode.get(node.id);
                    const problem = issues.some((issue) => issue.path.startsWith(`nodes[${index}]`));
                    return (
                      <div className="step" key={node.id}>
                        <div className="arrow" />
                        <div
                          className={`node ${node.id === selectedId ? "selected" : ""} ${node.enabled ? "" : "disabled"} ${nodeRun ? `run-${nodeRun.status}` : ""} ${problem ? "problem" : ""}`}
                          draggable
                          onDragStart={() => setDragIndex(index)}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={() => {
                            if (dragIndex !== null) move(dragIndex, index);
                            setDragIndex(null);
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedId(node.id);
                          }}
                        >
                          <div className="node-num">{index + 1}</div>
                          <div className="node-title">{node.name || info?.displayName || node.type}</div>
                          <div className="node-type">{node.type}</div>
                          {nodeRun && <div className="node-run">{nodeRun.status} · {nodeRun.durationMs} ms</div>}
                        </div>
                      </div>
                    );
                  })}
                  <div className="arrow" />
                  <div className="terminal end" />
                </div>
              </div>
            </>
          )}

          <section className="bottom">
            <div className="bottom-col">
              <h4>Run input (JSON)</h4>
              <textarea rows={5} value={runInput} spellCheck={false} onChange={(event) => setRunInput(event.target.value)} />
              <label className="inline">
                <input type="checkbox" checked={captureData} onChange={(event) => setCaptureData(event.target.checked)} /> Show node inputs/outputs (may include secrets)
              </label>
            </div>
            <div className="bottom-col wide">
              <h4>Problems and result</h4>
              {issues.length > 0 && (
                <ul className="issues">
                  {issues.map((issue, index) => (
                    <li key={index}><code>{issue.path}</code> {issue.message}</li>
                  ))}
                </ul>
              )}
              {result && (
                <div className={`result ${result.status}`}>
                  <div><strong>{result.status}</strong>{result.stopReason ? ` — ${result.stopReason}` : ""}{result.error ? ` — ${result.error.code}: ${result.error.message}` : ""}</div>
                  {result.output !== undefined && <pre>{JSON.stringify(result.output, null, 2)}</pre>}
                  {selectedId && runByNode.get(selectedId) && (
                    <details open>
                      <summary>Node "{selectedId}"</summary>
                      <pre>{JSON.stringify(runByNode.get(selectedId), null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
              {issues.length === 0 && !result && <div className="muted">Validate or run the workflow to see results here.</div>}
            </div>
          </section>
        </main>

        <aside className="props">
          <h3>Task</h3>
          {!draft ? (
            <div className="muted">Select a node to edit it.</div>
          ) : (
            <>
              <div className="field">
                <label>Label</label>
                <input value={draft.name ?? ""} placeholder={draftInfo?.displayName} onChange={(event) => setDraft({ ...draft, ...(event.target.value ? { name: event.target.value } : { name: undefined }) })} />
              </div>
              <div className="field">
                <label>Id</label>
                <input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
                <div className="hint">Used in templates: {"{{ nodes." + draft.id + ".output }}"}</div>
              </div>
              <div className="field">
                <label>Implementation</label>
                <input value={draft.type} disabled />
              </div>
              <div className="field">
                <label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enabled</label>
              </div>
              <h4>Configuration</h4>
              {draftInfo ? (
                <SchemaForm key={selected?.id} schema={draftInfo.configJsonSchema} value={draft.config} onChange={(config) => setDraft({ ...draft, config })} />
              ) : (
                <>
                  <div className="hint">Unknown node type. Edit raw config:</div>
                  <JsonField value={draft.config} rows={8} onCommit={(value) => setDraft({ ...draft, config: (value as Record<string, unknown>) ?? {} })} />
                </>
              )}
              <div className="buttons">
                <button className="primary" disabled={!draftDirty} onClick={apply}>Apply</button>
                <button disabled={!draftDirty} onClick={() => selected && setDraft(structuredClone(selected))}>Cancel</button>
              </div>
            </>
          )}
        </aside>
      </div>

      <footer className="statusbar">{status}</footer>
    </div>
  );
}
