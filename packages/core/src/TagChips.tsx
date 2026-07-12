interface TagChipsProps {
  tags: string[];
  filter: Set<string>;
  onToggle: (tag: string) => void;
}

/** Read-only filter chips for the dbt tags already on the graph (config.tags).
 * Clicking a chip toggles it into the active tag filter. */
export function TagChips(p: TagChipsProps) {
  if (!p.tags.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {p.tags.map((tag) => {
        const on = p.filter.has(tag);
        return (
          <button
            key={tag}
            onClick={() => p.onToggle(tag)}
            aria-pressed={on}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
              borderRadius: 20, border: `1px solid ${on ? "#3b82f6" : "#334155"}`,
              background: on ? "#16233d" : "#111827", fontSize: 12, color: "#e5e7eb",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            <span aria-hidden style={{ opacity: 0.6 }}>#</span>{tag}
          </button>
        );
      })}
    </div>
  );
}
