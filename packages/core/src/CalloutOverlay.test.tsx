// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ViewportPortal: ({ children }: { children: ReactNode }) => children,
}));

import { CalloutOverlay } from "./CalloutOverlay";

afterEach(cleanup);

describe("CalloutOverlay — dual bubbles", () => {
  const baseProps = {
    positions: new Map([["m", { x: 0, y: 200 }]]),
    dimmedIds: new Set<string>(),
    onSelect: () => {},
    selectedId: null,
    editingField: null as "gist" | "grain" | null,
    gistDraft: "", onGistChange: () => {},
    grainDraft: "", onGrainChange: () => {},
    onCommit: () => {}, onCancelEdit: () => {}, onBeginEdit: () => {},
  };
  const nodeWithBoth = {
    id: "m",
    meta: {
      dbt_open_lineage: {
        gist: "One row per invoice line.", callout: "top",
        grain: "transaction_line_id", grain_callout: "top",
      },
    },
  };

  it("renders both a gist and a grain bubble for a node with both callouts on", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    expect(getByText("One row per invoice line.")).toBeTruthy();
    expect(getByText("transaction_line_id")).toBeTruthy();
  });

  it("both bubbles render with square corners (border-radius 0)", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    expect(getByText("One row per invoice line.")).toHaveStyle({ borderRadius: "0" });
    expect(getByText("transaction_line_id")).toHaveStyle({ borderRadius: "0" });
  });

  it("grain bubble sits ABOVE gist's (a smaller top offset — further up the page) when both are on", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    const gistTop = parseFloat((getByText("One row per invoice line.") as HTMLElement).style.top);
    const grainTop = parseFloat((getByText("transaction_line_id") as HTMLElement).style.top);
    expect(grainTop).toBeLessThan(gistTop);
  });

  it("gist bubble has a higher z-index than grain's, so grain's leader renders behind it", () => {
    const { getByText } = render(<CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} />);
    const gistZ = Number((getByText("One row per invoice line.") as HTMLElement).style.zIndex);
    const grainZ = Number((getByText("transaction_line_id") as HTMLElement).style.zIndex);
    expect(gistZ).toBeGreaterThan(grainZ);
  });

  it("a grain-only node renders just the grain bubble, centered like a solo gist bubble", () => {
    const grainOnly = { id: "m", meta: { dbt_open_lineage: { grain: "gl_account_id per period", grain_callout: "top" } } };
    const { queryByText, getByText } = render(<CalloutOverlay {...baseProps} nodes={[grainOnly]} />);
    expect(queryByText(/invoice line/)).toBeNull();
    expect(getByText("gl_account_id per period")).toBeTruthy();
  });

  it("double-clicking the grain bubble calls onBeginEdit with the grain field", () => {
    const calls: [string, "gist" | "grain"][] = [];
    const { getByText } = render(
      <CalloutOverlay {...baseProps} nodes={[nodeWithBoth]} onBeginEdit={(id, field) => calls.push([id, field])} />,
    );
    getByText("transaction_line_id").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(calls).toEqual([["m", "grain"]]);
  });
});
