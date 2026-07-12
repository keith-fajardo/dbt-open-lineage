import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import { ViewportPortal, useReactFlow } from "@xyflow/react";
import { type Stroke, type Point, strokePath, eraseAt } from "./drawing";

export type DrawMode = "off" | "pen" | "erase";

interface DrawLayerProps {
  mode: DrawMode;
  color: string;
  width: number;
  strokes: Stroke[];
  onStrokesChange: (updater: (prev: Stroke[]) => Stroke[]) => void;
}

const ERASE_TOL = 8; // flow units

/** Freehand ink over the graph. A screen-fixed capture surface (active only in
 * pen/erase mode) turns pointer input into strokes stored in flow coordinates;
 * the strokes render in a ViewportPortal so they pan/zoom with the graph. Must
 * be rendered inside <ReactFlow> (uses useReactFlow). */
export function DrawLayer({ mode, color, width, strokes, onStrokesChange }: DrawLayerProps) {
  const rf = useReactFlow();
  const drawing = useRef(false);

  const toFlow = (e: ReactPointerEvent): Point => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y];
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
      {mode !== "off" && (
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
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
