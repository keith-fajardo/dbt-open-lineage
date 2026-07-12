import { type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useRef } from "react";
import { ViewportPortal, useReactFlow } from "@xyflow/react";
import { type Stroke, type Point, strokePath, eraseAt } from "./drawing";

export type DrawMode = "off" | "pen" | "erase";

interface DrawLayerProps {
  mode: DrawMode;
  color: string;
  width: number;
  strokes: Stroke[];
  onStrokesChange: (updater: (prev: Stroke[]) => Stroke[]) => void;
  /** Temporarily suspend capture (e.g. Space held) so the pane can pan. */
  paused?: boolean;
}

const ERASE_TOL = 8; // flow units

/** Freehand ink over the graph. A screen-fixed capture surface (active only in
 * pen/erase mode) turns pointer input into strokes stored in flow coordinates;
 * the strokes render in a ViewportPortal so they pan/zoom with the graph. Must
 * be rendered inside <ReactFlow> (uses useReactFlow). */
export function DrawLayer({ mode, color, width, strokes, onStrokesChange, paused = false }: DrawLayerProps) {
  const rf = useReactFlow();
  const drawing = useRef(false);

  const toFlow = (e: ReactPointerEvent): Point => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y];
  };

  // The capture surface sits over the pane and would otherwise swallow scroll,
  // so forward wheel to React Flow's zoom (keeps zoom working while drawing).
  const onWheel = (e: ReactWheelEvent) => {
    const z = rf.getZoom();
    const next = z * (e.deltaY < 0 ? 1.1 : 0.9);
    rf.zoomTo(Math.min(4, Math.max(0.05, next)), { duration: 0 });
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (mode === "off") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const pt = toFlow(e);
    if (mode === "erase") { onStrokesChange((prev) => eraseAt(prev, pt, ERASE_TOL)); return; }
    drawing.current = true;
    onStrokesChange((prev) => [...prev, { color, width, points: [pt] }]);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (mode === "erase" && (e.buttons & 1)) { const pt = toFlow(e); onStrokesChange((prev) => eraseAt(prev, pt, ERASE_TOL)); return; }
    if (mode !== "pen" || !drawing.current || !(e.buttons & 1)) return;
    const pt = toFlow(e);
    onStrokesChange((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const updated: Stroke = { ...last, points: [...last.points, pt] };
      return [...prev.slice(0, -1), updated];
    });
  };

  const onPointerUp = () => { drawing.current = false; };

  return (
    <>
      {mode !== "off" && !paused && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
          onWheel={onWheel}
          style={{
            position: "absolute", inset: 0, zIndex: 10,
            cursor: mode === "erase" ? "cell" : "crosshair",
            touchAction: "none",
          }}
        />
      )}
      <ViewportPortal>
        <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", width: 1, height: 1, pointerEvents: "none" }}>
          {strokes.map((s, i) => (
            <path
              key={i} d={strokePath(s.points)} fill="none" stroke={s.color} strokeWidth={s.width}
              strokeLinecap="round" strokeLinejoin="round"
              style={{ filter: `drop-shadow(0 0 3px ${s.color})` }}
            />
          ))}
        </svg>
      </ViewportPortal>
    </>
  );
}
