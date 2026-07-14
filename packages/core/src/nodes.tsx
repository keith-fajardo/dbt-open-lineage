import { useContext } from "react";
import { Handle, Position } from "@xyflow/react";
import { ViewContext, type ViewState } from "./viewContext";
import type { Status } from "./runStatus";

export type DimView = Pick<ViewState, "selected" | "active" | "up" | "down" | "matched" | "spotlight" | "filtered">;

/** The single source of truth for whether a node is dimmed. The open model is
 * never dimmed; a selection dims everything off its lineage; otherwise the
 * selector (matched), area spotlight, and label/personal filter each dim
 * non-members. */
export function isDimmed(id: string, v: DimView): boolean {
  if (id === v.active) return false;
  // Compose every dim reason so they stack: a spotlight/filter narrows even
  // while a node is selected (previously a selection short-circuited and
  // ignored spotlight/filter, so picking a spotlight did nothing until you
  // clicked away to deselect).
  const spotlit = v.spotlight == null || v.spotlight.has(id);
  const inFilter = v.filtered == null || v.filtered.has(id);
  const bySelector = v.matched != null && !v.matched.has(id);
  const offLineage = v.selected != null && !(id === v.selected || v.up.has(id) || v.down.has(id));
  return !spotlit || !inFilter || bySelector || offLineage;
}

const LAYER_COLOR: Record<string, string> = {
  source: "#8b5cf6",
  staging: "#3b82f6",
  intermediate: "#14b8a6",
  mart: "#f59e0b",
  report: "#ef4444",
  model: "#64748b",
};

/** The run-status marble's rendered state — every `Status` value plus "idle"
 * (no entry in `runStatus` for this node, or no run has ever touched it).
 * Idle is a UI-only default, never a value that arrives over `RunEvent`. */
export type MarbleState = Status | "idle";

/** Per-state color recipe for the run-status marble (see the render site for
 * how these compose into the gradient/glow). Tuned via a mocked-up eyeball
 * pass: running blinks orange, skipped is the same hue but solid so the two
 * stay distinguishable only by motion; failed is a deeper/cooler red than a
 * plain #ef4444 because a translucent warm red drifts toward looking orange
 * next to running otherwise. Idle is always shown (a grey marble on every
 * node), not hidden, so the indicator reads as a persistent light rather
 * than something that only appears mid-run. */
const RUN_STATUS_RGB: Record<MarbleState, {
  rgb: string; hi: number; a1: number; a2: number; a3: number;
  glint: number; glow: number; glowSpread: number; glowAlpha: number;
}> = {
  idle: { rgb: "148, 163, 184", hi: 0.8, a1: 0.72, a2: 0.62, a3: 0.3, glint: 0.28, glow: 5, glowSpread: 1, glowAlpha: 0.5 },
  running: { rgb: "249, 115, 22", hi: 0.95, a1: 0.9, a2: 0.82, a3: 0.45, glint: 0.45, glow: 8, glowSpread: 2, glowAlpha: 0.95 },
  success: { rgb: "57, 255, 20", hi: 0.9, a1: 0.85, a2: 0.78, a3: 0.4, glint: 0.4, glow: 6, glowSpread: 1.5, glowAlpha: 0.85 },
  failed: { rgb: "220, 38, 38", hi: 0.85, a1: 0.88, a2: 0.8, a3: 0.45, glint: 0.38, glow: 6, glowSpread: 1.5, glowAlpha: 0.85 },
  skipped: { rgb: "245, 158, 11", hi: 0.9, a1: 0.85, a2: 0.78, a3: 0.4, glint: 0.4, glow: 6, glowSpread: 1.5, glowAlpha: 0.8 },
};

export interface DagNodeData {
  label: string;
  layer: string;
  /** config.materialized — bottom-left corner label ("" hides it). */
  materialized: string;
  /** Number of dbt tests attached — bottom-right corner badge (0 hides it). */
  testCount: number;
  /** Resolved colors of this node's labels (meta.labels), left-edge stripes. */
  labelColors?: string[];
  [key: string]: unknown;
}

/** Wrap every occurrence of `q` (case-insensitive) in a <mark>. */
function highlightLabel(label: string, q: string) {
  if (!q) return label;
  const lower = label.toLowerCase();
  const parts: (string | { m: string; k: number })[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at < 0) { parts.push(label.slice(i)); break; }
    if (at > i) parts.push(label.slice(i, at));
    parts.push({ m: label.slice(at, at + q.length), k: k++ });
    i = at + q.length;
  }
  return parts.map((p) =>
    typeof p === "string" ? p : (
      <mark key={p.k} style={{ background: "#fbbf24", color: "#0b1220", borderRadius: 2, padding: "0 1px" }}>
        {p.m}
      </mark>
    ));
}

export function DagNode({ id, data }: { id: string; data: DagNodeData }) {
  const color = LAYER_COLOR[data.layer] ?? LAYER_COLOR.model;
  // Selection/emphasis comes from context so drags never rebuild node objects.
  const view = useContext(ViewContext);
  const hasSel = view.selected != null;
  const inLineage = id === view.selected || view.up.has(id) || view.down.has(id);
  const selected = id === view.selected;
  // The model whose file is OPEN in the IDE: a persistent emphasis so it's
  // always obvious which node in the cone you're actually looking at.
  const active = id === view.active;
  const dim = isDimmed(id, view);
  const emphasize = hasSel && !selected && inLineage;
  const searchHit = view.search !== "" && data.label.toLowerCase().includes(view.search);
  return (
    <div
      title={active ? `${data.label} (open)` : data.label}
      style={{
        width: 180, height: 44, borderRadius: 8,
        border: active ? `2px solid #e5e7eb` : `2px solid ${color}`,
        boxShadow: active
          ? `0 0 0 3px #e5e7eb, 0 0 18px 3px ${color}` // open model: white ring + colored glow
          : selected
            ? `0 0 0 2px #e5e7eb`
            : emphasize
              ? `0 0 0 2px ${color}`
              : searchHit
                ? `0 0 0 2px #fbbf24` // amber ring: search match, visible at low zoom
                : "none",
        background: active ? "#111c30" : "#0b1220", color: "#e5e7eb",
        opacity: dim ? 0.18 : 1,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, lineHeight: 1.25, textAlign: "center",
        padding: "2px 10px", boxSizing: "border-box",
        transition: "opacity 120ms",
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Left} />
      {(() => {
        const fav = view.favorites.has(id);
        return (
          <button
            aria-label={fav ? "unfavorite" : "favorite"}
            title={fav ? "Unfavorite" : "Favorite"}
            onClick={(e) => { e.stopPropagation(); view.onToggleFavorite(id); }}
            style={{
              position: "absolute", right: 5, top: 3, padding: 0, lineHeight: 1,
              background: "none", border: "none", cursor: "pointer",
              color: fav ? "#fbbf24" : "#475569", fontSize: 12,
            }}
          >
            {fav ? "★" : "☆"}
          </button>
        );
      })()}
      {data.labelColors && data.labelColors.length > 0 && (
        <div aria-hidden style={{ position: "absolute", left: 3, top: 6, bottom: 6, display: "flex", gap: 2 }}>
          {data.labelColors.map((c, i) => (
            <span key={i} data-label-stripe style={{ width: 3, borderRadius: 3, background: c, display: "block" }} />
          ))}
        </div>
      )}
      {/* Run-status marble: inset in the corner mirroring the ☆ favorite,
          transparent glass rather than a solid bulb — the body stays richly
          colored through ~70% of its radius (a full fade-to-transparent
          reads as a black marble with a colored halo) while the outer rim
          tapers to let a hint of the node's own dark fill show through, plus
          a lower-right glint opposite the main highlight, which is what
          sells "glass" over "painted dot". Always rendered — no entry in
          runStatus defaults to "idle" (grey), so the marble reads as a
          persistent light on every node, not something that only appears
          mid-run. */}
      {(() => {
        const status: MarbleState = view.runStatus?.get(id) ?? "idle";
        const rgb = RUN_STATUS_RGB[status];
        const style: React.CSSProperties = {
          position: "absolute", left: 8, top: 4, width: 9, height: 9, borderRadius: "50%",
          background: [
            `radial-gradient(circle at 68% 80%, rgba(255,255,255,${rgb.glint}) 0%, rgba(255,255,255,0) 40%)`,
            `radial-gradient(circle at 32% 26%, rgba(255,255,255,${rgb.hi}) 0%, rgba(${rgb.rgb}, ${rgb.a1}) 30%, rgba(${rgb.rgb}, ${rgb.a2}) 68%, rgba(${rgb.rgb}, ${rgb.a3}) 100%)`,
          ].join(", "),
          boxShadow: `0 0 ${rgb.glow}px ${rgb.glowSpread}px rgba(${rgb.rgb}, ${rgb.glowAlpha})`,
        };
        if (status === "running") style.animation = "dol-run-blink 1s ease-in-out infinite";
        return <div aria-label={`run status: ${status}`} data-run-status={status} style={style} />;
      })()}
      {/* dbt names have no spaces (snake_case), so allow breaks anywhere and
          clamp to 2 lines — the title attribute carries the full name. */}
      <span
        style={{
          overflow: "hidden",
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflowWrap: "anywhere",
          wordBreak: "break-word",
          // Keep long, wrapped names clear of the corner adornments: the
          // favorite ★ (top-right) and the label stripes (left edge).
          padding: "0 13px",
          boxSizing: "border-box",
          maxWidth: "100%",
        }}
      >
        {highlightLabel(data.label, view.search)}
      </span>
      {/* Corner metadata: materialization bottom-left, test count bottom-right. */}
      {data.materialized && (
        <span
          title={`materialized: ${data.materialized}`}
          style={{
            position: "absolute", left: 5, bottom: 1,
            fontSize: 8, lineHeight: 1, color: "#94a3b8", letterSpacing: 0.2,
          }}
        >
          {data.materialized}
        </span>
      )}
      {data.testCount > 0 && (
        <span
          title={`${data.testCount} test${data.testCount === 1 ? "" : "s"}`}
          aria-label={`${data.testCount} tests`}
          style={{
            position: "absolute", right: 4, bottom: 2,
            minWidth: 12, height: 11, padding: "0 3px", borderRadius: 6,
            background: "rgba(148, 163, 184, 0.22)", color: "#cbd5e1",
            fontSize: 8, lineHeight: "11px", textAlign: "center",
          }}
        >
          {data.testCount}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { dag: DagNode };
