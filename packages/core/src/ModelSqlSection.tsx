import { useEffect, useState } from "react";
import { invoke } from "./bridge";

interface ModelSql { raw: string; compiled: string }

/** SQL section of the details drawer. Owns its own fetch/state so App.tsx
 * doesn't grow more per-selection state. Fetches raw + compiled SQL for the
 * selected node via the host command `dbt.modelSql`, defaulting to the raw
 * source. Read-only; scrollable; copyable. */
export function ModelSqlSection({ nodeId }: { nodeId: string }) {
  const [sql, setSql] = useState<ModelSql | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  const [mode, setMode] = useState<"raw" | "compiled">("raw");

  // Re-fetch whenever the selected node changes. `cancelled` guards against a
  // stale response (an earlier node's SQL) overwriting a newer selection.
  useEffect(() => {
    let cancelled = false;
    setSql(null); setErr(false); setMode("raw"); setLoading(true);
    invoke<ModelSql>("dbt.modelSql", { id: nodeId })
      .then((r) => { if (!cancelled) { setSql(r); setLoading(false); } })
      // The rejection reason is never rendered — the UI always shows the same
      // fixed "SQL unavailable" copy — so err only needs to be a boolean.
      .catch(() => { if (!cancelled) { setErr(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [nodeId]);

  const text = mode === "raw" ? sql?.raw ?? "" : sql?.compiled ?? "";
  const compiledEmpty = mode === "compiled" && sql !== null && sql.compiled === "";

  const tabStyle = (active: boolean) => ({
    padding: "2px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
    border: "1px solid #334155",
    background: active ? "#1f2937" : "transparent",
    color: active ? "#e5e7eb" : "#94a3b8",
  });

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 4 }}>sql</div>
      <div role="tablist" aria-label="sql mode" style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        {(["raw", "compiled"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m}
            onClick={() => setMode(m)} style={tabStyle(mode === m)}>{m}</button>
        ))}
        <button onClick={() => { if (text) void navigator.clipboard?.writeText(text); }}
          aria-label="copy sql" title="Copy" disabled={!text}
          style={{ ...tabStyle(false), marginLeft: "auto" }}>copy</button>
      </div>
      {loading && <div style={{ color: "#94a3b8", fontSize: 12 }}>loading…</div>}
      {err && (
        <div style={{ color: "#fca5a5", fontSize: 12 }}>
          SQL unavailable — run <code>dbt compile</code>
        </div>
      )}
      {!loading && !err && compiledEmpty && (
        <div style={{ color: "#94a3b8", fontSize: 12 }}>
          Not compiled yet — run <code>dbt compile</code>
        </div>
      )}
      {!loading && !err && !compiledEmpty && (
        <pre aria-label="model sql" style={{
          margin: 0, maxHeight: 300, overflow: "auto",
          background: "#0b1220", border: "1px solid #334155", borderRadius: 6,
          padding: 8, fontSize: 11, fontFamily: "ui-monospace, monospace",
          color: "#e5e7eb", whiteSpace: "pre",
        }}>{text}</pre>
      )}
    </div>
  );
}
