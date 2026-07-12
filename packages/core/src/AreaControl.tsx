import { useState } from "react";
import { type Style } from "./styles";

interface AreaControlProps {
  areas: string[];
  styles: Map<string, Style>;
  visible: Set<string>;
  onVisibleChange: (next: Set<string>) => void;
  spot: string | null;
  onSpot: (area: string | null) => void;
  shape: "box" | "hull";
  onShape: (s: "box" | "hull") => void;
}

// Small-caps section label — the mockup's structural device, reused across the
// toolbar so each control group reads as a named section.
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: "0.09em",
  textTransform: "uppercase", color: "#94a3b8", whiteSpace: "nowrap",
};

// Segmented control (the mockup's `.seg`): one bordered pill, cells divided by
// hairlines, the active cell filled blue. `first` drops the divider.
const segCell = (on: boolean, first: boolean): React.CSSProperties => ({
  padding: "6px 11px", border: "none", borderRadius: 0,
  borderLeft: first ? "none" : "1px solid #334155", cursor: "pointer",
  fontFamily: "inherit", fontSize: 12,
  background: on ? "#2563eb" : "transparent",
  color: on ? "#fff" : "#94a3b8",
});
const SEG_WRAP: React.CSSProperties = {
  display: "inline-flex", background: "#0b1220",
  border: "1px solid #334155", borderRadius: 7, overflow: "hidden",
};

// Compact dropdown trigger + panel, shared shape with the Tags ▾ control.
const ddBtn = (active: boolean): React.CSSProperties => ({
  padding: "6px 10px", borderRadius: 7,
  border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
  background: active ? "#16233d" : "#111827",
  color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
});

/** Area-visibility dropdown, a Zone-shape segmented toggle, and a Spotlight
 * selector — grouped under small-caps section labels (Zone / Spotlight).
 * No areas ⇒ renders nothing (keeps the toolbar clean for un-annotated projects). */
export function AreaControl(p: AreaControlProps) {
  const [open, setOpen] = useState(false);
  if (!p.areas.length) return null;
  const toggle = (area: string) => {
    const next = new Set(p.visible);
    next.has(area) ? next.delete(area) : next.add(area);
    p.onVisibleChange(next);
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <div style={{ position: "relative" }}>
        <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          style={ddBtn(p.visible.size < p.areas.length)}>
          Areas · {p.visible.size}/{p.areas.length} ▾
        </button>
        {open && (
          <div role="menu" style={{
            position: "absolute", left: 0, top: "110%", zIndex: 20, minWidth: 220,
            background: "#111827", border: "1px solid #334155", borderRadius: 8, padding: 4,
            boxShadow: "0 16px 34px rgba(0,0,0,0.5)",
          }}>
            {p.areas.map((area) => {
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

      <span style={SECTION_LABEL}>Zone</span>
      <div style={SEG_WRAP}>
        {(["box", "hull"] as const).map((s, i) => (
          <button key={s} onClick={() => p.onShape(s)} style={segCell(p.shape === s, i === 0)}>{s}</button>
        ))}
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
