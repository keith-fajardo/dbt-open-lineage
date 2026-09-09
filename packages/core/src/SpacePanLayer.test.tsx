// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const rf = vi.hoisted(() => {
  let viewport = { x: 10, y: 20, zoom: 2 };
  return {
    getViewport: vi.fn(() => viewport),
    setViewport: vi.fn((next: typeof viewport) => { viewport = next; }),
    reset: () => { viewport = { x: 10, y: 20, zoom: 2 }; },
  };
});

vi.mock("@xyflow/react", () => ({ useReactFlow: () => rf }));

import { SpacePanLayer } from "./SpacePanLayer";

describe("SpacePanLayer", () => {
  beforeEach(() => { rf.reset(); rf.getViewport.mockClear(); rf.setViewport.mockClear(); });

  it("moves the viewport from a Space-held drag without changing zoom", () => {
    render(<SpacePanLayer active />);
    const layer = screen.getByTestId("space-pan-layer");

    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 100, clientY: 100, isPrimary: true });
    fireEvent.pointerMove(layer, { buttons: 1, pointerId: 1, clientX: 135, clientY: 82, isPrimary: true });

    expect(rf.setViewport).toHaveBeenLastCalledWith(
      { x: 45, y: 2, zoom: 2 },
      { duration: 0 },
    );
    expect(layer).toHaveStyle({ cursor: "grabbing" });
  });

  it("does not render a pointer surface when Space is not held", () => {
    render(<SpacePanLayer active={false} />);
    expect(screen.queryByTestId("space-pan-layer")).not.toBeInTheDocument();
  });
});
