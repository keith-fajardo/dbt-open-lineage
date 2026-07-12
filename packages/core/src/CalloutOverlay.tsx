import { ViewportPortal } from "@xyflow/react";
import { type Pt } from "./zones";
import { NODE_W } from "./layout";

interface CalloutOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  dimmedIds: Set<string>;
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
 * gist or without a meta.callout placement gets none. */
export function CalloutOverlay({ nodes, positions, dimmedIds }: CalloutOverlayProps) {
  return (
    <ViewportPortal>
      {nodes.map((n) => {
        const text = gistOf(n);
        const p = text ? positions.get(n.id) : undefined;
        if (!text || !p) return null;
        const anchorX = p.x + NODE_W / 2;
        const bubbleW = 200;
        const bubbleLeft = anchorX - bubbleW / 2;
        const bubbleBottom = p.y - 14; // gap above node top
        return (
          <div key={n.id} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", opacity: dimmedIds.has(n.id) ? 0.25 : 1 }}>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
              <line x1={anchorX} y1={bubbleBottom} x2={anchorX} y2={p.y - 1} stroke="#38bdf8" strokeWidth={2} />
              <circle cx={anchorX} cy={p.y - 1} r={3.5} fill="#38bdf8" />
            </svg>
            <div
              style={{
                position: "absolute", left: bubbleLeft, top: bubbleBottom, transform: "translateY(-100%)",
                width: bubbleW, boxSizing: "border-box",
                background: "#38bdf8", color: "#0a0f1a", borderRadius: 9, padding: "8px 11px",
                font: "500 12px/1.34 inherit", boxShadow: "0 8px 22px rgba(0,0,0,0.5)",
              }}
            >
              {text}
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
