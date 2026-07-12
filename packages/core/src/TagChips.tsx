import { useState } from "react";

interface TagChipsProps {
  tags: string[];
  filter: Set<string>;
  onToggle: (tag: string) => void;
}

/** dbt tags (config.tags) collapsed into one compact "Tags ▾" multi-select,
 * mirroring AreaControl's "Areas ▾" dropdown — a checkbox list, one row per
 * tag, that keeps the filter working (toggling a row calls onToggle). A flat
 * grid of every tag buried the rest of the toolbar; a single chip-sized control
 * does not. Renders nothing when the project has no tags. */
export function TagChips(p: TagChipsProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  if (!p.tags.length) return null;
  const active = p.filter.size > 0;
  const q = query.trim().toLowerCase();
  const shown = q ? p.tags.filter((t) => t.toLowerCase().includes(q)) : p.tags;
  return (
    <div style={{ position: "relative" }}>
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
        Tags{active ? ` · ${p.filter.size}` : ""} ▾
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", left: 0, top: "110%", zIndex: 20, minWidth: 200, maxHeight: 320, overflowY: "auto",
          background: "#111827", border: "1px solid #334155", borderRadius: 8, padding: 4,
          boxShadow: "0 16px 34px rgba(0,0,0,0.5)",
        }}>
          <input
            aria-label="Filter tags"
            placeholder="Filter tags…"
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
            <div style={{ padding: "6px 8px", color: "#64748b", fontSize: 12 }}>No tags match</div>
          )}
          {shown.map((tag) => {
            const on = p.filter.has(tag);
            return (
              <label key={tag} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                color: "#e5e7eb", fontSize: 13, cursor: "pointer", borderRadius: 6 }}>
                <input type="checkbox" checked={on} onChange={() => p.onToggle(tag)} aria-label={tag} />
                <span aria-hidden style={{ opacity: 0.5 }}>#</span>{tag}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
