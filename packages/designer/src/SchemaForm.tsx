import { useState } from "react";

interface Schema {
  type?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  description?: string;
  maxLength?: number;
  default?: unknown;
  advanced?: boolean;
  strictJson?: boolean;
}

const LONG_TEXT = new Set(["instructions", "prompt", "body", "content", "text", "reason"]);

function toText(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Free-form field: JSON when it parses, otherwise plain text (so "{{ templates }}" survive). */
function JsonField({ value, onCommit, rows }: { value: unknown; onCommit(value: unknown): void; rows: number }) {
  const [text, setText] = useState(() => toText(value));
  return (
    <textarea
      rows={rows}
      value={text}
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text === toText(value)) return;
        if (text.trim() === "") return onCommit(undefined);
        try {
          onCommit(JSON.parse(text));
        } catch {
          onCommit(text);
        }
      }}
    />
  );
}

/** JSON object field that only commits valid JSON and shows the parse error while typing. */
function StrictJsonField({ value, onCommit }: { value: unknown; onCommit(value: unknown): void }) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);

  const change = (next: string): void => {
    setText(next);
    if (next.trim() === "") {
      setError("Required: a JSON Schema object");
      return onCommit(undefined);
    }
    try {
      const parsed: unknown = JSON.parse(next);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Must be a JSON object");
        return;
      }
      setError(null);
      onCommit(parsed);
    } catch (cause) {
      setError(`Invalid JSON: ${cause instanceof Error ? cause.message : "parse error"}`);
    }
  };

  return (
    <>
      <textarea rows={9} value={text} spellCheck={false} className={error ? "invalid" : ""} onChange={(event) => change(event.target.value)} />
      {error ? <div className="field-error">{error} (not applied)</div> : <div className="field-ok">Valid JSON</div>}
    </>
  );
}

function Field(props: { name: string; schema: Schema; required: boolean; value: unknown; onChange(value: unknown): void }) {
  const { name, schema, required, value, onChange } = props;
  let control: React.ReactNode;

  if (schema.strictJson) {
    control = <StrictJsonField value={value} onCommit={onChange} />;
  } else if (Array.isArray(schema.enum)) {
    control = (
      <select value={typeof value === "string" ? value : typeof schema.default === "string" ? schema.default : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}>
        {!required && schema.default === undefined && <option value="">(default)</option>}
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "string") {
    const long = LONG_TEXT.has(name) || (schema.maxLength ?? 0) >= 1000;
    const text = typeof value === "string" ? value : toText(value);
    const set = (next: string): void => onChange(next === "" && !required ? undefined : next);
    control = long ? (
      <textarea rows={5} value={text} onChange={(event) => set(event.target.value)} />
    ) : (
      <input type="text" value={text} onChange={(event) => set(event.target.value)} />
    );
  } else if (schema.type === "boolean") {
    control = <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
  } else {
    control = <JsonField value={value} onCommit={onChange} rows={schema.type === "object" || schema.type === "array" || schema.type === undefined ? 4 : 1} />;
  }

  return (
    <div className="field">
      <label>
        {name}
        {required && <span className="req"> *</span>}
      </label>
      {control}
      {schema.description && <div className="hint">{schema.description}</div>}
    </div>
  );
}

export function SchemaForm(props: { schema: unknown; value: Record<string, unknown>; onChange(value: Record<string, unknown>): void }) {
  const schema = props.schema as Schema;
  const properties = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);

  if (properties.length === 0) return <div className="hint">This node has no configuration.</div>;

  const renderField = ([name, propSchema]: [string, Schema]) => (
    <Field
      key={name}
      name={name}
      schema={propSchema}
      required={required.has(name)}
      value={props.value[name]}
      onChange={(next) => {
        const copy = { ...props.value };
        if (next === undefined) delete copy[name];
        else copy[name] = next;
        props.onChange(copy);
      }}
    />
  );
  const basic = properties.filter(([, propSchema]) => !propSchema.advanced);
  const advanced = properties.filter(([, propSchema]) => propSchema.advanced);

  return (
    <>
      {basic.map(renderField)}
      {advanced.length > 0 && (
        <details className="advanced">
          <summary>Advanced</summary>
          {advanced.map(renderField)}
        </details>
      )}
      <div className="hint">Text values accept templates such as {"{{ input.x }}"} or {"{{ nodes.<id>.output.y }}"}.</div>
    </>
  );
}

export { JsonField };
