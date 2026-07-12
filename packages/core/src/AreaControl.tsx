import { useCallback, useRef, useState } from "react";
import { useCloseOnOutside } from "./useCloseOnOutside";
import { type Style } from "./styles";

interface AreaControlProps {
  areas: string[];
  styles: Map<string, Style>;
  /** The set of subject areas currently filtered on (empty = show all). */
  filter: Set<string>;
  onToggle: (area: string) => void;
}

/** A "Subject areas ▾" multi-select filter, mirroring TagChips: a searchable
 * checkbox list, one row per area (color swatch + name). Checking areas narrows
 * the DAG to their members (OR within, AND with other filter categories) and
 * draws only those zones. Renders nothing when the project has no areas. */
export function AreaControl(p: AreaControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useCloseOnOutside(open, ref, close);
  if (!p.areas.length) return null;
  const active = p.filter.size > 0;
  const nameOf = (k: string) => p.styles.get(k)?.name ?? k;
  const q = query.trim().toLowerCase();
  const shown = q ? p.areas.filter((a) => nameOf(a).toLowerCase().includes(q) || a.toLowerCase().includes(q)) : p.areas;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => { if (v) setQuery(""); return !v; })}
        style={{
          padding: "6px 10px", borderRadius: 7,
          border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
          background: active ? "#16233d" : "#111827",
          color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
        }}>
        Subject areas{active ? ` · ${p.filter.size}` : ""} ▾
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", left: 0, top: "110%", zIndex: 20, minWidth: 220, maxHeight: 320, overflowY: "auto",
          background: "#111827", border: "1px solid #334155", borderRadius: 8, padding: 4,
          boxShadow: "0 16px 34px rgba(0,0,0,0.5)",
        }}>
          <input
            aria-label="Filter subject areas"
            placeholder="Filter subject areas…"
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
            <div style={{ padding: "6px 8px", color: "#64748b", fontSize: 12 }}>No areas match</div>
          )}
          {shown.map((area) => {
            const st = p.styles.get(area) ?? { name: area, color: "#64748b" };
            const on = p.filter.has(area);
            return (
              <label key={area} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                color: "#e5e7eb", fontSize: 13, cursor: "pointer", borderRadius: 6 }}>
                <input type="checkbox" checked={on} onChange={() => p.onToggle(area)} aria-label={st.name} />
                <span style={{ width: 11, height: 11, borderRadius: 3, background: st.color, flexShrink: 0 }} />
                {st.name}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
