import { useState } from "react";
import { fallbackColor, type Annotations } from "./annotations";

interface AreaControlProps {
  areas: string[];
  annotations: Annotations;
  visible: Set<string>;
  onVisibleChange: (next: Set<string>) => void;
  spot: string | null;
  onSpot: (area: string | null) => void;
  shape: "box" | "hull";
  onShape: (s: "box" | "hull") => void;
}

const btn = (on: boolean): React.CSSProperties => ({
  padding: "6px 10px", borderRadius: 6, border: "1px solid #334155",
  background: on ? "#2563eb" : "#111827", color: "#e5e7eb",
  cursor: "pointer", fontFamily: "inherit", fontSize: 13,
});

/** Zone-shape toggle, an area-visibility dropdown, and a spotlight selector.
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
      <div style={{ display: "inline-flex", border: "1px solid #334155", borderRadius: 6, overflow: "hidden" }}>
        {(["box", "hull"] as const).map((s) => (
          <button key={s} onClick={() => p.onShape(s)}
            style={{ ...btn(p.shape === s), border: "none", borderRadius: 0 }}>{s}</button>
        ))}
      </div>

      <div style={{ position: "relative" }}>
        <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={btn(false)}>
          Areas · {p.visible.size}/{p.areas.length} ▾
        </button>
        {open && (
          <div role="menu" style={{
            position: "absolute", left: 0, top: "110%", zIndex: 20, minWidth: 220,
            background: "#111827", border: "1px solid #334155", borderRadius: 6, padding: 4,
          }}>
            {p.areas.map((area, i) => {
              const st = p.annotations.areas[area] ?? { label: area, color: fallbackColor(i) };
              return (
                <label key={area} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  color: "#e5e7eb", fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={p.visible.has(area)} onChange={() => toggle(area)} />
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: st.color }} />
                  {st.label}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <select
        aria-label="Spotlight area"
        value={p.spot ?? ""}
        onChange={(e) => p.onSpot(e.target.value || null)}
        style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #334155",
          background: "#111827", color: "#e5e7eb", fontFamily: "inherit", fontSize: 13 }}
      >
        <option value="">Spotlight: none</option>
        {p.areas.map((area, i) => (
          <option key={area} value={area}>{p.annotations.areas[area]?.label ?? area}</option>
        ))}
      </select>
    </div>
  );
}
