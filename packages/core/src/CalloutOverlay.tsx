import { useRef } from "react";
import { ViewportPortal } from "@xyflow/react";
import { type Pt } from "./zones";
import { NODE_W } from "./layout";
import { readMeta } from "./meta";

interface CalloutOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  dimmedIds: Set<string>;
  /** Single click a bubble → select its model (opens the details panel to edit the gist/grain). */
  onSelect: (id: string) => void;
  /** The currently selected node id (drives which bubble may enter inline edit). */
  selectedId: string | null;
  /** Which field of the CURRENTLY SELECTED node's bubbles is being edited
   * inline, if any. Only one bubble across the whole overlay is ever in
   * edit mode at once. */
  editingField: "gist" | "grain" | null;
  /** The shared gist edit buffer — bound to the panel's gist textarea too, so the
   * two stay in sync automatically (both read/write the same App state). */
  gistDraft: string;
  /** Update the shared gist buffer (= App's setGistDraft). */
  onGistChange: (v: string) => void;
  /** The shared grain edit buffer, mirroring gistDraft. */
  grainDraft: string;
  /** Update the shared grain buffer (= App's setGrainDraft). */
  onGrainChange: (v: string) => void;
  /** Commit the edit (= save gist+grain+callouts to yaml, then leave edit mode). */
  onCommit: () => void;
  /** Leave edit mode WITHOUT saving (Escape). Persistence still governed by the
   * panel's Save/Revert; this just stops the inline edit. */
  onCancelEdit: () => void;
  /** Double click a bubble → select the node AND enter inline edit for that field. */
  onBeginEdit: (id: string, field: "gist" | "grain") => void;
}

/** Pure text→height geometry for ONE bubble — no gap or margin included. The
 * single source of truth both `estimateCalloutHeight` (one bubble) and
 * `estimateStackedCalloutHeight` (one or two, stacked) build on, so they can
 * never drift apart. */
function bubbleHeightOnly(text: string, bubbleWidth = 184): number {
  const innerW = bubbleWidth - 18;          // padding 9*2
  const charsPerLine = Math.max(1, Math.floor(innerW / 5.4)); // ~11px avg char width
  const lines = Math.max(1, Math.ceil(text.trim().length / charsPerLine));
  return lines * 11 * 1.35 + 12;            // line-height 1.35, padding 6*2
}

/** Estimate the rendered height (px, flow-space) of a SINGLE callout bubble
 * for a given note, so the layout can RESERVE that much vertical space above
 * the node (see layout.ts). Single source of truth: the constants here MUST
 * match the bubble actually rendered further down this file — fontSize 11,
 * lineHeight 1.35, padding "6px 9px", bubbleW 184, leader gap 14. */
export function estimateCalloutHeight(text: string, bubbleWidth = 184): number {
  return Math.round(bubbleHeightOnly(text, bubbleWidth) + 14 + 20); // + leader gap (14) + margin (20)
}

/** Reserved height for whichever bubble(s) actually show on a node — `null`
 * for either argument means that bubble isn't showing. One 14px gap per
 * bubble-to-something boundary (bubble→node, or bubble→bubble when both
 * stack): `estimateStackedCalloutHeight(gistText, null)` is arithmetically
 * IDENTICAL to `estimateCalloutHeight(gistText)`, so existing single-gist
 * installs get byte-identical layout. */
export function estimateStackedCalloutHeight(
  gistText: string | null, grainText: string | null, bubbleWidth = 184,
): number {
  if (!gistText && !grainText) return 0;
  const gistH = gistText != null ? bubbleHeightOnly(gistText, bubbleWidth) : 0;
  const grainH = grainText != null ? bubbleHeightOnly(grainText, bubbleWidth) : 0;
  const gaps = (gistText ? 1 : 0) + (grainText ? 1 : 0);
  return Math.round(gistH + grainH + gaps * 14 + 20);
}

/** The model's gist text, or null if there is no gist or no callout
 * placement to anchor it to. Reads via readMeta — namespaced
 * meta.dbt_open_lineage.{gist,callout} first, falling back to the legacy
 * flat meta.{gist,callout}. Exported for direct testing. */
export function gistOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "gist");
  const c = readMeta(node.meta, "callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}

/** The model's grain text, or null if there is no grain or no grain_callout
 * placement to anchor it to. Mirrors `gistOf` exactly, reading
 * `grain`/`grain_callout` instead of `gist`/`callout`. Exported for direct
 * testing. */
export function grainOf(node: { meta?: Record<string, unknown> }): string | null {
  const g = readMeta(node.meta, "grain");
  const c = readMeta(node.meta, "grain_callout");
  if (typeof g !== "string" || !g.trim() || !c) return null;
  return g.trim();
}

interface CalloutBubbleProps {
  text: string;
  bottom: number;   // flow-space y of the bubble's BOTTOM edge
  left: number;     // flow-space x of the bubble's LEFT edge
  width: number;
  zIndex: number;
  background: string;
  textColor: string;
  isEditing: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onCommit: () => void;
  onCancelEdit: () => void;
  cancelledRef: React.MutableRefObject<boolean>;
  onSelect: () => void;
  onBeginEdit: () => void;
}

/** One callout bubble — used twice per node (gist, grain) so the click/edit
 * mechanics never drift between the two. */
function CalloutBubble({
  text, bottom, left, width, zIndex, background, textColor,
  isEditing, draft, onDraftChange, onCommit, onCancelEdit, cancelledRef,
  onSelect, onBeginEdit,
}: CalloutBubbleProps) {
  return (
    <div
      title={isEditing ? undefined : "Double-click to edit this note"}
      onClick={(e) => { e.stopPropagation(); if (!isEditing) onSelect(); }}
      onDoubleClick={(e) => { e.stopPropagation(); onBeginEdit(); }}
      style={{
        position: "absolute", left, top: bottom, transform: "translateY(-100%)",
        width, boxSizing: "border-box", pointerEvents: "auto", cursor: isEditing ? "text" : "pointer",
        background, color: textColor, borderRadius: 0, padding: "6px 9px", zIndex,
        fontSize: 11, fontWeight: 500, lineHeight: 1.35, boxShadow: "0 8px 22px rgba(0,0,0,0.5)",
      }}
    >
      {isEditing ? (
        <textarea
          aria-label="Edit callout note"
          value={draft}
          autoFocus
          rows={2}
          onChange={(e) => onDraftChange(e.target.value)}
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
  );
}

/** Callout bubbles pinned above their node, rendered in flow-space so they
 * pan/zoom with the graph and track the node when it is dragged (the caller
 * passes live node positions). A node can show a gist bubble, a grain
 * bubble, both (stacked, grain above gist), or neither.
 *
 * Each bubble anchors INDEPENDENTLY all the way to the node with its own
 * leader line — when both are on, grain's leader is drawn 20px left of
 * gist's and behind gist's bubble (lower z-index), so it reads as passing
 * through rather than stopping at gist's edge. Gist's own bubble position
 * never moves whether or not grain also shows.
 *
 * Single click selects the node (opens the details panel). Double click
 * edits that SPECIFIC bubble's note in place: a <textarea> replaces the
 * static text, bound to the matching draft buffer (gistDraft or
 * grainDraft), so typing in either the bubble or the panel field mirrors
 * live. Only one bubble across the whole overlay is ever in edit mode at
 * once (`editingField`, paired with `selectedId`). */
export function CalloutOverlay({
  nodes, positions, dimmedIds, onSelect, selectedId, editingField,
  gistDraft, onGistChange, grainDraft, onGrainChange, onCommit, onCancelEdit, onBeginEdit,
}: CalloutOverlayProps) {
  // Guards commit-on-blur: Escape sets this so the blur that fires when the
  // textarea unmounts (edit mode ends) does not also save. Shared across
  // both bubbles: only one is ever mid-edit at a time (editingField is a
  // single value), so there's no cross-talk between them.
  const cancelledRef = useRef(false);
  return (
    <ViewportPortal>
      {nodes.map((n) => {
        const gText = gistOf(n);
        const grText = grainOf(n);
        if (!gText && !grText) return null;
        const p = positions.get(n.id);
        if (!p) return null;
        const isEditingGist = editingField === "gist" && n.id === selectedId;
        const isEditingGrain = editingField === "grain" && n.id === selectedId;
        const anchorX = p.x + NODE_W / 2;
        const bubbleW = 184;
        const bubbleLeft = anchorX - bubbleW / 2;
        const gistBottom = p.y - 14;
        const gistHeight = gText ? bubbleHeightOnly(gText) : 0;
        // Grain stacks directly above gist's TOP edge (same 14px gap
        // reused for bubble-to-bubble as for bubble-to-node) when both
        // show; otherwise it uses the same solo position gist uses alone.
        const grainBottom = grText ? (gText ? gistBottom - gistHeight - 14 : p.y - 14) : 0;
        // Only offset left when BOTH bubbles actually stack — a solo grain
        // bubble (no gist) has nothing to avoid overlapping, so its leader
        // stays centered like a solo gist bubble's does.
        const grainLeaderX = gText ? anchorX - 20 : anchorX;
        return (
          <div key={n.id} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", opacity: dimmedIds.has(n.id) ? 0.25 : 1 }}>
            {grText && (
              <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                <line x1={grainLeaderX} y1={grainBottom} x2={grainLeaderX} y2={p.y - 1} stroke="#38bdf8" strokeWidth={2} />
                <circle cx={grainLeaderX} cy={p.y - 1} r={3.5} fill="#38bdf8" />
              </svg>
            )}
            {gText && (
              <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                <line x1={anchorX} y1={gistBottom} x2={anchorX} y2={p.y - 1} stroke="#facc15" strokeWidth={2} />
                <circle cx={anchorX} cy={p.y - 1} r={3.5} fill="#facc15" />
              </svg>
            )}
            {grText && (
              <CalloutBubble
                text={grText} bottom={grainBottom} left={bubbleLeft} width={bubbleW} zIndex={1}
                background="#7dd3fc" textColor="#0c2f3f"
                isEditing={isEditingGrain} draft={grainDraft} onDraftChange={onGrainChange}
                onCommit={onCommit} onCancelEdit={onCancelEdit} cancelledRef={cancelledRef}
                onSelect={() => onSelect(n.id)} onBeginEdit={() => onBeginEdit(n.id, "grain")}
              />
            )}
            {gText && (
              <CalloutBubble
                text={gText} bottom={gistBottom} left={bubbleLeft} width={bubbleW} zIndex={2}
                background="#fde047" textColor="#1c1917"
                isEditing={isEditingGist} draft={gistDraft} onDraftChange={onGistChange}
                onCommit={onCommit} onCancelEdit={onCancelEdit} cancelledRef={cancelledRef}
                onSelect={() => onSelect(n.id)} onBeginEdit={() => onBeginEdit(n.id, "gist")}
              />
            )}
          </div>
        );
      })}
    </ViewportPortal>
  );
}
