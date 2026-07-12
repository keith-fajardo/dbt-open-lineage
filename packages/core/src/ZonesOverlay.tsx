import { ViewportPortal } from "@xyflow/react";
import { areaMembers, memberCorners, boundingBox, convexHull, padHull, type Pt } from "./zones";
import { type Style } from "./styles";

const ZONE_PAD = 18;

interface ZonesOverlayProps {
  nodes: { id: string; meta?: Record<string, unknown> }[];
  positions: Map<string, Pt>;
  styles: Map<string, Style>;
  areasVisible: Set<string>;
  shape: "box" | "hull";
}

/** Subject-area zones rendered inside the flow viewport so they pan/zoom with
 * the graph. Members that lack a position (filtered out) are skipped. */
export function ZonesOverlay({ nodes, positions, styles, areasVisible, shape }: ZonesOverlayProps) {
  const keys = [...areasVisible].sort();
  return (
    <ViewportPortal>
      {keys.map((area) => {
        const ids = areaMembers(nodes, area);
        const corners = memberCorners(positions, ids);
        const box = boundingBox(corners, ZONE_PAD);
        if (!box) return null;
        const style = styles.get(area) ?? { name: area, color: "#64748b" };
        return (
          <div key={area} data-area={area} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
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
                const hull = padHull(convexHull(corners), ZONE_PAD);
                if (hull.length < 3) return null;
                const d = "M" + hull.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ") + " Z";
                return (
                  <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1 }}>
                    <path d={d} fill={`${style.color}17`} stroke={style.color}
                      strokeWidth={1.5} strokeDasharray="7 5" strokeLinejoin="round" />
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
              {style.name} <span style={{ opacity: 0.8, fontWeight: 500 }}>{ids.length}</span>
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
