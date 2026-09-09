import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useReactFlow } from "@xyflow/react";

interface SpacePanLayerProps {
  active: boolean;
}

interface PanGesture {
  pointerId: number;
  clientX: number;
  clientY: number;
}

/** Screen-fixed pointer surface for Space-held viewport navigation.
 *
 * React Flow deliberately gives draggable/selectable nodes a `nopan` class,
 * which is correct for normal node interaction but means a gesture beginning
 * on a node can still win the race with the pane when the graph is zoomed.
 * This surface is only mounted while Space is held, sits above the renderer,
 * and moves the viewport directly. Consequently the original pointer target
 * is never a node and cannot trigger a node click or drag.
 */
export function SpacePanLayer({ active }: SpacePanLayerProps) {
  const rf = useReactFlow();
  const gesture = useRef<PanGesture | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!active) {
      gesture.current = null;
      setDragging(false);
    }
  }, [active]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gesture.current = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId || !(e.buttons & 1)) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - g.clientX;
    const dy = e.clientY - g.clientY;
    if (dx === 0 && dy === 0) return;
    const viewport = rf.getViewport();
    rf.setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy }, { duration: 0 });
    g.clientX = e.clientX;
    g.clientY = e.clientY;
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture.current || gesture.current.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    gesture.current = null;
    setDragging(false);
  };

  if (!active) return null;
  return (
    <div
      data-testid="space-pan-layer"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        position: "absolute", inset: 0, zIndex: 4,
        cursor: dragging ? "grabbing" : "grab",
        pointerEvents: "auto", touchAction: "none", userSelect: "none",
      }}
    />
  );
}
