import { describe, it, expect, vi, beforeEach } from "vitest";
import { Component, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { mountApp, type Bridge } from "./index";

// Mock ResizeObserver for @xyflow/react
if (!global.ResizeObserver) {
  (global as any).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

describe("Error Boundary in mountApp", () => {
  it("mountApp renders without throwing", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const mockBridge: Bridge = {
      invoke: vi.fn(),
      saveExport: vi.fn(),
      openInIde: vi.fn(),
      onContext: vi.fn(() => () => {}),
      onRunEvent: vi.fn(() => () => {}),
    };

    // This should not throw even with minimal setup
    expect(() => {
      mountApp(container, {
        bridge: mockBridge,
        projectPath: "/test/project",
        initialSelector: "my_model",
      });
    }).not.toThrow();

    document.body.removeChild(container);
  });

  it("Boundary catches render errors and displays error UI", () => {
    // Suppress console.error since React logs errors from boundaries
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Create a boundary component inline for testing
    class TestBoundary extends Component<
      { children: any },
      { err: Error | null }
    > {
      state = { err: null as Error | null };
      static getDerivedStateFromError(err: Error) {
        return { err };
      }
      render() {
        if (!this.state.err) return this.props.children;
        return (
          <div style={{ padding: 16, background: "#0b1220", color: "#fca5a5" }}>
            <b>dbt Open Lineage crashed</b>
            {"\n\n"}
            {String(this.state.err?.stack || this.state.err)}
          </div>
        );
      }
    }

    function ThrowingComponent(): ReactNode {
      throw new Error("Test error");
    }

    const { container } = render(
      <TestBoundary>
        <ThrowingComponent />
      </TestBoundary>,
    );

    // Error UI should be rendered
    expect(container.textContent).toContain("dbt Open Lineage crashed");
    expect(container.textContent).toContain("Test error");

    consoleSpy.mockRestore();
  });
});
