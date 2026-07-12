import { useCallback, useRef, useState } from "react";
import { useCloseOnOutside } from "./useCloseOnOutside";
import { type Style } from "./styles";

interface AreaControlProps {
  areas: string[];
  styles: Map<string, Style>;
  /** The spotlighted area (dims everything else + draws only its zone). */
  spot: string | null;
  onSpot: (area: string | null) => void;
}

const ddBtn = (active: boolean): React.CSSProperties => ({
  padding: "6px 10px", borderRadius: 7,
  border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
  background: active ? "#16233d" : "#111827",
  color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
});

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
  padding: "6px 8px", borderRadius: 6, cursor: "pointer",
  background: "none", border: "none", color: "#e5e7eb", fontFamily: "inherit", fontSize: 13,
};

/** A single "Subject areas ▾" dropdown: picking an area spotlights it (dims the
 * rest, draws just its zone); "None" clears. Searchable. Renders nothing when
 * there are no areas. */
export function AreaControl(p: AreaControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useCloseOnOutside(open, ref, close);
  if (!p.areas.length) return null;
  const nameOf = (k: string) => p.styles.get(k)?.name ?? k;
  const q = query.trim().toLowerCase();
  const shown = q ? p.areas.filter((a) => nameOf(a).toLowerCase().includes(q) || a.toLowerCase().includes(q)) : p.areas;
  const pick = (area: string | null) => { p.onSpot(area); close(); };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => { if (v) setQuery(""); return !v; })}
        style={ddBtn(p.spot != null)}>
        Subject areas{p.spot != null ? ` · ${nameOf(p.spot)}` : ""} ▾
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
          <button type="button" onClick={() => pick(null)}
            style={{ ...rowStyle, color: p.spot == null ? "#e5e7eb" : "#94a3b8", fontWeight: p.spot == null ? 600 : 400 }}>
            <span style={{ width: 11, textAlign: "center" }}>{p.spot == null ? "✓" : ""}</span>
            None (show all)
          </button>
          {shown.length === 0 && (
            <div style={{ padding: "6px 8px", color: "#64748b", fontSize: 12 }}>No areas match</div>
          )}
          {shown.map((area) => {
            const st = p.styles.get(area) ?? { name: area, color: "#64748b" };
            const on = p.spot === area;
            return (
              <button key={area} type="button" onClick={() => pick(area)}
                style={{ ...rowStyle, background: on ? "#16233d" : "none", fontWeight: on ? 600 : 400 }}>
                <span style={{ width: 11, textAlign: "center", color: "#3b82f6" }}>{on ? "✓" : ""}</span>
                <span style={{ width: 11, height: 11, borderRadius: 3, background: st.color, flexShrink: 0 }} />
                {st.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
