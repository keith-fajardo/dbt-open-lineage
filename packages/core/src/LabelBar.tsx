import { type Style } from "./styles";

interface LabelBarProps {
  labels: string[];
  styles: Map<string, Style>;
  filter: Set<string>;
  onToggle: (label: string) => void;
  onColor: (label: string, color: string) => void;
}

/** Filter chips, one per label: a color swatch (opens a native color picker
 * that writes the sidecar) + the label name (click toggles the filter).
 * Renders nothing when there are no labels. */
export function LabelBar(p: LabelBarProps) {
  if (!p.labels.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {p.labels.map((label) => {
        const st = p.styles.get(label) ?? { name: label, color: "#64748b" };
        const on = p.filter.has(label);
        return (
          <span
            key={label}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 11px",
              borderRadius: 20, border: `1px solid ${on ? "#3b82f6" : "#334155"}`,
              background: on ? "#16233d" : "#111827", fontSize: 12, color: "#e5e7eb",
            }}
          >
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
            <button
              onClick={() => p.onToggle(label)}
              aria-pressed={on}
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", font: "inherit", padding: 0 }}
            >
              {st.name}
            </button>
          </span>
        );
      })}
    </div>
  );
}
