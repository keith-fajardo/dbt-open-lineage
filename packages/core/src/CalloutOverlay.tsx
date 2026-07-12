import { useRef } from "react";
import { ViewportPortal } from "@xyflow/react";
import { type Pt } from "./zones";
import { NODE_W } from "./layout";

interface CalloutOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  dimmedIds: Set<string>;
  /** Single click a bubble → select its model (opens the details panel to edit the gist). */
  onSelect: (id: string) => void;
  /** The currently selected node id (drives which bubble may enter inline edit). */
  selectedId: string | null;
  /** True while the selected callout is being edited inline. */
  editing: boolean;
  /** The shared gist edit buffer — bound to the panel's gist textarea too, so the
   * two stay in sync automatically (both read/write the same App state). */
  gistDraft: string;
  /** Update the shared gist buffer (= App's setGistDraft). */
  onGistChange: (v: string) => void;
  /** Commit the edit (= save gist+callout to yaml, then leave edit mode). */
  onCommit: () => void;
  /** Leave edit mode WITHOUT saving (Escape). Persistence still governed by the
   * panel's Save/Revert; this just stops the inline edit. */
  onCancelEdit: () => void;
  /** Double click a bubble → select the node AND enter inline edit. */
  onBeginEdit: (id: string) => void;
}

function gistOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = node.meta?.gist;
  const c = node.meta?.callout;
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}

/** Callout bubbles pinned above their node, rendered in flow-space so they
 * pan/zoom with the graph and track the node when it is dragged (the caller
 * passes live node positions). Text is the model's meta.gist; a node without a
 * gist or without a meta.callout placement gets none.
 *
 * Single click selects the node (opens the details panel). Double click edits
 * the note in place: a <textarea> replaces the static text, bound to the same
 * gistDraft buffer as the panel's gist field, so typing in either mirrors live. */
export function CalloutOverlay({
  nodes, positions, dimmedIds, onSelect,
  selectedId, editing, gistDraft, onGistChange, onCommit, onCancelEdit, onBeginEdit,
}: CalloutOverlayProps) {
  // Guards commit-on-blur: Escape sets this so the blur that fires when the
  // textarea unmounts (edit mode ends) does not also save.
  const cancelledRef = useRef(false);
  return (
    <ViewportPortal>
      {nodes.map((n) => {
        const text = gistOf(n);
        const p = text ? positions.get(n.id) : undefined;
        if (!text || !p) return null;
        const isEditing = editing && n.id === selectedId;
        const anchorX = p.x + NODE_W / 2;
        const bubbleW = 184;
        const bubbleLeft = anchorX - bubbleW / 2;
        const bubbleBottom = p.y - 14; // gap above node top
        return (
          <div key={n.id} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", opacity: dimmedIds.has(n.id) ? 0.25 : 1 }}>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
              <line x1={anchorX} y1={bubbleBottom} x2={anchorX} y2={p.y - 1} stroke="#facc15" strokeWidth={2} />
              <circle cx={anchorX} cy={p.y - 1} r={3.5} fill="#facc15" />
            </svg>
            <div
              title={isEditing ? undefined : "Double-click to edit this note"}
              onClick={(e) => { e.stopPropagation(); if (!isEditing) onSelect(n.id); }}
              onDoubleClick={(e) => { e.stopPropagation(); onBeginEdit(n.id); }}
              style={{
                position: "absolute", left: bubbleLeft, top: bubbleBottom, transform: "translateY(-100%)",
                width: bubbleW, boxSizing: "border-box", pointerEvents: "auto", cursor: isEditing ? "text" : "pointer",
                background: "#fde047", color: "#1c1917", borderRadius: 8, padding: "6px 9px",
                fontSize: 11, fontWeight: 500, lineHeight: 1.35, boxShadow: "0 8px 22px rgba(0,0,0,0.5)",
              }}
            >
              {isEditing ? (
                <textarea
                  aria-label="Edit callout note"
                  value={gistDraft}
                  autoFocus
                  rows={2}
                  onChange={(e) => onGistChange(e.target.value)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={() => { if (cancelledRef.current) { cancelledRef.current = false; return; } onCommit(); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(); }
                    else if (e.key === "Escape") { e.preventDefault(); cancelledRef.current = true; onCancelEdit(); }
                  }}
                  style={{
                    display: "block", width: "100%", boxSizing: "border-box", margin: 0, padding: 0,
                    background: "transparent", color: "#0a0f1a", border: "none", outline: "none",
                    fontFamily: "inherit", fontSize: 11, fontWeight: 500, lineHeight: 1.35,
                    resize: "none", pointerEvents: "auto",
                  }}
                />
              ) : text}
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
