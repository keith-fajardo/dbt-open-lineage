import { ViewportPortal } from "@xyflow/react";
import { areaMembers, memberCorners, boundingBox, convexHull, padHull, type Pt } from "./zones";
import { fallbackColor, type Annotations } from "./annotations";

const ZONE_PAD = 18;

interface ZonesOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  annotations: Annotations;
  areasVisible: Set<string>;
  shape: "box" | "hull";
}

/** Renders subject-area zones inside the flow viewport so they pan/zoom with
 * the graph. Box shape only in this task; hull is added in Task 5. */
export function ZonesOverlay({ nodes, positions, annotations, areasVisible, shape }: ZonesOverlayProps) {
  // Stable order: sidecar order first, then any ad-hoc areas, alphabetical.
  const keys = [...areasVisible].sort();
  return (
    <ViewportPortal>
      {keys.map((area, i) => {
        const ids = areaMembers(nodes, area);
        const box = boundingBox(memberCorners(positions, ids), ZONE_PAD);
        if (!box) return null;
        const style = annotations.areas[area] ?? { label: area, color: fallbackColor(i) };
        const count = ids.length;
        return (
          <div key={area} data-area={area} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
            {/* Box drawn as a positioned div; hull (Task 5) swaps to an SVG path. */}
            {shape === "box" ? (
              <div
                style={{
                  position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h,
                  border: `1.5px dashed ${style.color}`, borderRadius: 14,
                  background: `${style.color}14`, boxSizing: "border-box",
                }}
              />
            ) : (
              (() => {
                const hull = padHull(convexHull(memberCorners(positions, ids)), ZONE_PAD);
                if (hull.length < 3) return null;
                const d = "M" + hull.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ") + " Z";
                return (
                  <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                    <path
                      d={d} fill={`${style.color}17`} stroke={style.color}
                      strokeWidth={1.5} strokeDasharray="7 5" strokeLinejoin="round"
                    />
                  </svg>
                );
              })()
            )}
            <div
              style={{
                position: "absolute", left: box.x, top: box.y, transform: "translateY(-100%)",
                background: style.color, color: "#fff", padding: "4px 9px",
                borderRadius: "7px 7px 0 0", font: "600 11px/1 inherit", whiteSpace: "nowrap",
              }}
            >
              {style.label} <span style={{ opacity: 0.8, fontWeight: 500 }}>{count}</span>
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
