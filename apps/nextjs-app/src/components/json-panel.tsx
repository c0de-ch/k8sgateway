/** Pretty-printed JSON block used for API responses and decoded tokens. */
export function JsonPanel({ title, value }: { title?: string; value: unknown }) {
  return (
    <div className="json-panel">
      {title && <div className="json-title">{title}</div>}
      <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
