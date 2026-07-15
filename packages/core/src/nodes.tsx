import { useContext, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { ViewContext, type ViewState } from "./viewContext";
import { endpointKey } from "./columnTrace";
import type { RunDisplayStatus } from "./runStatus";

export type DimView = Pick<ViewState, "selected" | "active" | "up" | "down" | "matched" | "spotlight" | "filtered">;

/** Shared empty set so optional ViewState column fields default without allocating. */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

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

/** The run-status marble's rendered state — every `RunDisplayStatus` value
 * plus "idle" (no entry in `runStatus` for this node, or no run has ever
 * touched it). Idle is a UI-only default, never a value that arrives over
 * `RunEvent` (queued is also UI-only, but it IS part of `RunDisplayStatus`
 * — see runStatus.ts). */
export type MarbleState = RunDisplayStatus | "idle";

/** Per-state color recipe for the run-status marble (see the render site for
 * how these compose into the gradient/glow). Tuned via a mocked-up eyeball
 * pass: running blinks orange; skipped was originally the same hue held
 * static, but that read as indistinguishable from running at a glance, so
 * skipped is now a clear yellow (`#facc15`) instead — steady, no blink, and
 * no longer orange-family. Failed is a deeper/cooler red than a plain
 * #ef4444 because a translucent warm red drifts toward looking orange next
 * to running otherwise. Idle is always shown (a grey marble on every
 * node), not hidden, so the indicator reads as a persistent light rather
 * than something that only appears mid-run. Queued is a distinct sky-blue —
 * a plain grey would have been indistinguishable from idle, defeating the
 * point of showing "this node is part of the run, waiting its turn" versus
 * "not part of this run at all". Steady, not blinking, so it doesn't
 * compete with running's more urgent blink. */
const RUN_STATUS_RGB: Record<MarbleState, {
  rgb: string; hi: number; a1: number; a2: number; a3: number;
  glint: number; glow: number; glowSpread: number; glowAlpha: number;
}> = {
  idle: { rgb: "148, 163, 184", hi: 0.8, a1: 0.72, a2: 0.62, a3: 0.3, glint: 0.28, glow: 5, glowSpread: 1, glowAlpha: 0.5 },
  queued: { rgb: "56, 189, 248", hi: 0.85, a1: 0.78, a2: 0.68, a3: 0.35, glint: 0.32, glow: 5, glowSpread: 1, glowAlpha: 0.6 },
  running: { rgb: "249, 115, 22", hi: 0.95, a1: 0.9, a2: 0.82, a3: 0.45, glint: 0.45, glow: 8, glowSpread: 2, glowAlpha: 0.95 },
  success: { rgb: "57, 255, 20", hi: 0.9, a1: 0.85, a2: 0.78, a3: 0.4, glint: 0.4, glow: 6, glowSpread: 1.5, glowAlpha: 0.85 },
  failed: { rgb: "220, 38, 38", hi: 0.85, a1: 0.88, a2: 0.8, a3: 0.45, glint: 0.38, glow: 6, glowSpread: 1.5, glowAlpha: 0.85 },
  skipped: { rgb: "250, 204, 21", hi: 0.9, a1: 0.85, a2: 0.78, a3: 0.4, glint: 0.4, glow: 6, glowSpread: 1.5, glowAlpha: 0.8 },
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
  /** Column-lineage mode only. PRESENT (even if []) ⇒ render the column body.
   * These are the user's MANUALLY PICKED columns. Static per build key
   * (Invariant 2's allowed exception, like labelColors). DagNode renders the
   * UNION of these with any column on the live trace (via allColumns) — see
   * the `rendered` derivation in DagNode below; this array alone is not the
   * full set of rows shown. */
  columns?: { name: string; hasLineage: boolean }[];
  /** The node's full column catalog, for the in-node pick dropdown. */
  allColumns?: { name: string; hasLineage: boolean }[];
  /** Box size from estimateColumnNodeSize (column mode). */
  width?: number;
  height?: number;
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

/** The `+ trace column…` strip under a node's header. Opens a text-filtered
 * dropdown of the node's full column catalog; picking adds a row (stays open
 * for picking several). Already-picked columns show a check and unpick. */
function PickBar({
  id, data, picked, onPick, onUnpick,
}: {
  id: string;
  data: DagNodeData;
  picked: Set<string>;
  onPick?: (node: string, column: string) => void;
  onUnpick?: (node: string, column: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const all = data.allColumns ?? [];
  const ql = q.trim().toLowerCase();
  const shown = all.filter((c) => ql === "" || c.name.toLowerCase().includes(ql));
  return (
    <div style={{ position: "relative", flex: "0 0 auto", padding: "2px 6px", height: 22, boxSizing: "border-box" }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{
          width: "100%", height: 18, textAlign: "left", cursor: "pointer",
          background: "#0b1220", border: "1px dashed #334155", borderRadius: 4,
          color: "#94a3b8", fontSize: 10, padding: "0 6px", fontFamily: "inherit",
        }}
      >+ trace column…</button>
      {open && (
        <div
          role="listbox"
          className="dol-thin-scroll"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Bubbles up from whichever child has focus (input or an option
            // button after a pick) — Escape closes regardless of which one.
            if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
          }}
          style={{
            position: "absolute", left: 6, right: 6, top: "100%", zIndex: 40,
            maxHeight: 180, overflowY: "auto",
            background: "#111827", border: "1px solid #334155", borderRadius: 6, padding: 4,
            scrollbarWidth: "thin", scrollbarColor: "#334155 transparent",
            boxShadow: "0 12px 28px rgba(0,0,0,0.5)",
          }}>
          {/* Chromium (VSCode/Mnemo webviews) ignores scrollbar-width/-color;
              this pseudo-element rule is the only way to thin its scrollbar. */}
          <style>{"\
            .dol-thin-scroll::-webkit-scrollbar{width:6px;height:6px}\
            .dol-thin-scroll::-webkit-scrollbar-track{background:transparent}\
            .dol-thin-scroll::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}\
          "}</style>
          <input
            autoFocus value={q} placeholder="filter columns…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) { e.preventDefault();
                picked.has(shown[0].name) ? onUnpick?.(id, shown[0].name) : onPick?.(id, shown[0].name); }
            }}
            style={{ width: "100%", boxSizing: "border-box", marginBottom: 4, padding: "3px 6px",
              background: "#0b1220", border: "1px solid #334155", borderRadius: 4,
              color: "#e5e7eb", fontSize: 10, fontFamily: "inherit" }}
          />
          {shown.map((c) => {
            const on = picked.has(c.name);
            return (
              <button
                key={c.name} role="option" aria-selected={on}
                onClick={() => (on ? onUnpick?.(id, c.name) : onPick?.(id, c.name))}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
                  background: "none", border: "none", cursor: "pointer", borderRadius: 4,
                  color: c.hasLineage ? "#e5e7eb" : "#64748b",
                  fontFamily: "ui-monospace, monospace", fontSize: 9.5, padding: "3px 6px",
                }}
              >
                <span aria-hidden style={{ width: 12 }}>{on ? "✓" : ""}</span>
                {c.name}{!c.hasLineage && <span style={{ color: "#475569" }}> (unresolved)</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  // The Prev/Next "current" hit gets a visibly stronger ring than the other
  // (still-amber) matches, so stepping reads as a spotlight, not just a count.
  const isCurrentHit = view.currentHit != null && view.currentHit === id;
  // The chrome shared by both the normal fixed box and the column-mode
  // header: run-status marble, favorite star, label stripes, name, corner
  // badges, and the two node-level handles. Moved verbatim — no styling or
  // behavior change from what used to be the outer <div>'s only children.
  const header = (
    <>
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
          mid-run. Sources are the one exception: dbt never runs/tests a
          source directly, so a status light on one is always meaningless
          idle noise — skip it entirely rather than always-grey. */}
      {data.layer !== "source" && (() => {
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
    </>
  );
  // Normal path: today's exact fixed box, byte-identical (column branch unreachable).
  if (data.columns == null) {
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
                  ? (isCurrentHit ? `0 0 0 3px #fbbf24` : `0 0 0 2px #fbbf24`) // amber ring: search match, visible at low zoom (stronger for the current Prev/Next hit)
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
        {header}
      </div>
    );
  }
  // Column path: header chrome on top, a `+ trace column…` pick bar, then one
  // row per RENDERED column. Outer box is content-sized; the header stays 44px.
  const picked = new Set((data.columns ?? []).map((c) => c.name));
  const selKey = view.selectedColumn ? endpointKey(view.selectedColumn.node, view.selectedColumn.column) : null;
  const trace = view.columnTrace ?? EMPTY_KEYS;
  const searchHits = view.columnSearchHits ?? EMPTY_KEYS;
  const current = view.currentHit ?? null;
  // RENDERED rows = manually PICKED columns ∪ any column on the live trace
  // passing through this node (transient, visual-only — never written back to
  // pickedColumns/data.columns). Computed here, at render time, from
  // data.allColumns + view.columnTrace — both already exist (Task 4). When the
  // trace clears (columnTrace empty), the union collapses back to just the
  // picked set on the very next render — no cleanup code needed, no stray rows
  // survive a toggle-off. A column that is both picked AND on the trace is
  // still only in the union once (the `!picked.has` guard below skips it).
  const onTraceOnly = (data.allColumns ?? []).filter(
    (c) => !picked.has(c.name) && trace.has(endpointKey(id, c.name)),
  );
  const rendered = [...(data.columns ?? []), ...onTraceOnly];
  return (
    <div
      title={active ? `${data.label} (open)` : data.label}
      style={{
        width: data.width ?? 180, minHeight: data.height ?? 44, borderRadius: 8,
        border: active ? `2px solid #e5e7eb` : `2px solid ${color}`,
        boxShadow: active
          ? `0 0 0 3px #e5e7eb, 0 0 18px 3px ${color}`
          : selected ? `0 0 0 2px #e5e7eb`
          : emphasize ? `0 0 0 2px ${color}`
          : searchHit ? (isCurrentHit ? `0 0 0 3px #fbbf24` : `0 0 0 2px #fbbf24`)
          : "none",
        background: active ? "#111c30" : "#0b1220", color: "#e5e7eb",
        opacity: dim ? 0.18 : 1,
        display: "flex", flexDirection: "column",
        boxSizing: "border-box", transition: "opacity 120ms", position: "relative",
      }}
    >
      {/* 44px header — same chrome as normal mode, same relative positioning. */}
      <div style={{
        height: 44, position: "relative", flex: "0 0 auto",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, lineHeight: 1.25, textAlign: "center", padding: "2px 10px",
      }}>
        {header}
      </div>
      <PickBar id={id} data={data} picked={picked} onPick={view.onPickColumn} onUnpick={view.onUnpickColumn} />
      {rendered.map((col) => {
        const key = endpointKey(id, col.name);
        const onTrace = key === selKey || trace.has(key);
        const isHit = searchHits.has(key);
        const isCurrent = current === key;
        return (
          <div
            key={col.name}
            data-col-row
            data-on-trace={onTrace ? "true" : "false"}
            title={col.name}
            onClick={(e) => { e.stopPropagation(); view.onSelectColumn?.(id, col.name); }}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              height: 18, padding: "0 8px", cursor: "pointer",
              fontFamily: "ui-monospace, monospace", fontSize: 9.5,
              color: col.hasLineage ? "#cbd5e1" : "#64748b",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              background: onTrace ? "rgba(56,189,248,0.18)" : isHit ? "rgba(251,191,36,0.15)" : "transparent",
              boxShadow: isCurrent ? "inset 0 0 0 2px #fbbf24" : "none",
            }}
          >
            <span aria-hidden style={{
              width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
              background: onTrace ? "#38bdf8" : isHit ? "#fbbf24" : "#334155",
            }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {highlightLabel(col.name, view.search)}
            </span>
            <Handle type="target" position={Position.Left} id={col.name} style={{ background: "#38bdf8" }} />
            <Handle type="source" position={Position.Right} id={col.name} style={{ background: "#38bdf8" }} />
          </div>
        );
      })}
    </div>
  );
}

export const nodeTypes = { dag: DagNode };
