import { useCallback, useRef, useState } from "react";
import { type Style } from "./styles";
import { useCloseOnOutside } from "./useCloseOnOutside";

interface LabelBarProps {
  labels: string[];
  styles: Map<string, Style>;
  filter: Set<string>;
  onToggle: (label: string) => void;
  onColor: (label: string, color: string) => void;
}

/** Labels collapsed into a compact "Labels ▾" dropdown, mirroring the Tags
 * control: a searchable checkbox list, one row per label. Each row also carries
 * a color swatch (opens a native picker that recolors the label, persisted to
 * the sidecar). Toggling a row's checkbox/name updates the label filter.
 * Renders nothing when there are no labels. */
export function LabelBar(p: LabelBarProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useCloseOnOutside(open, ref, close);
  if (!p.labels.length) return null;
  const active = p.filter.size > 0;
  const q = query.trim().toLowerCase();
  const nameOf = (k: string) => p.styles.get(k)?.name ?? k;
  const shown = q ? p.labels.filter((l) => nameOf(l).toLowerCase().includes(q) || l.toLowerCase().includes(q)) : p.labels;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => { if (v) setQuery(""); return !v; })}
        style={{
          padding: "6px 10px", borderRadius: 7,
          border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
          background: active ? "#16233d" : "#111827",
          color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
        }}
      >
        Labels{active ? ` · ${p.filter.size}` : ""} ▾
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", left: 0, top: "110%", zIndex: 20, minWidth: 220, maxHeight: 320, overflowY: "auto",
          background: "#111827", border: "1px solid #334155", borderRadius: 8, padding: 4,
          boxShadow: "0 16px 34px rgba(0,0,0,0.5)",
        }}>
          <input
            aria-label="Filter labels"
            placeholder="Filter labels…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            style={{
              display: "block", width: "100%", boxSizing: "border-box", margin: "2px 0 4px",
              padding: "5px 8px", borderRadius: 6, border: "1px solid #334155",
              background: "#0b1220", color: "#e5e7eb", fontFamily: "inherit", fontSize: 12,
            }}
          />
          {shown.length === 0 && (
            <div style={{ padding: "6px 8px", color: "#64748b", fontSize: 12 }}>No labels match</div>
          )}
          {shown.map((label) => {
            const st = p.styles.get(label) ?? { name: label, color: "#64748b" };
            const on = p.filter.has(label);
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                color: "#e5e7eb", fontSize: 13, borderRadius: 6 }}>
                <input type="checkbox" checked={on} onChange={() => p.onToggle(label)} aria-label={st.name} style={{ cursor: "pointer" }} />
                <label
                  style={{ width: 14, height: 14, borderRadius: 4, background: st.color, cursor: "pointer",
                    position: "relative", flex: "none", boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }}
                  title={`Recolor ${st.name}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="color" value={st.color}
                    onChange={(e) => p.onColor(label, e.target.value)}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", border: 0, padding: 0 }}
                  />
                </label>
                <span onClick={() => p.onToggle(label)} style={{ cursor: "pointer", flex: 1 }}>{st.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
