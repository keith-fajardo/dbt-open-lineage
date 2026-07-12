import { useCallback, useRef, useState } from "react";
import { useCloseOnOutside } from "./useCloseOnOutside";
import { type Style } from "./styles";

interface AreaControlProps {
  areas: string[];
  styles: Map<string, Style>;
  visible: Set<string>;
  onVisibleChange: (next: Set<string>) => void;
  spot: string | null;
  onSpot: (area: string | null) => void;
}

// Small-caps section label — the mockup's structural device, reused across the
// toolbar so each control group reads as a named section.
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: "0.09em",
  textTransform: "uppercase", color: "#94a3b8", whiteSpace: "nowrap",
};

// Compact dropdown trigger, shared shape with the Tags ▾ / Labels ▾ controls.
const ddBtn = (active: boolean): React.CSSProperties => ({
  padding: "6px 10px", borderRadius: 7,
  border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
  background: active ? "#16233d" : "#111827",
  color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
});

/** A searchable Subject-areas visibility dropdown + a Spotlight selector.
 * No areas ⇒ renders nothing (keeps the toolbar clean for un-annotated projects). */
export function AreaControl(p: AreaControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useCloseOnOutside(open, ref, close);
  if (!p.areas.length) return null;
  const toggle = (area: string) => {
    const next = new Set(p.visible);
    next.has(area) ? next.delete(area) : next.add(area);
    p.onVisibleChange(next);
  };
  const nameOf = (k: string) => p.styles.get(k)?.name ?? k;
  const q = query.trim().toLowerCase();
  const shown = q ? p.areas.filter((a) => nameOf(a).toLowerCase().includes(q) || a.toLowerCase().includes(q)) : p.areas;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <div ref={ref} style={{ position: "relative" }}>
        <button aria-haspopup="menu" aria-expanded={open}
          onClick={() => setOpen((v) => { if (v) setQuery(""); return !v; })}
          style={ddBtn(p.visible.size < p.areas.length)}>
          Subject areas · {p.visible.size}/{p.areas.length} ▾
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
              return (
                <label key={area} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  color: "#e5e7eb", fontSize: 13, cursor: "pointer", borderRadius: 6 }}>
                  <input type="checkbox" checked={p.visible.has(area)} onChange={() => toggle(area)} />
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: st.color }} />
                  {st.name}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <span style={SECTION_LABEL}>Spotlight</span>
      <select
        aria-label="Spotlight area"
        value={p.spot ?? ""}
        onChange={(e) => p.onSpot(e.target.value || null)}
        style={{ padding: "6px 8px", borderRadius: 7, border: "1px solid #334155",
          background: "#111827", color: "#e5e7eb", fontFamily: "inherit", fontSize: 12 }}
      >
        <option value="">None</option>
        {p.areas.map((area) => (
          <option key={area} value={area}>{p.styles.get(area)?.name ?? area}</option>
        ))}
      </select>
    </div>
  );
}
