// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Status } from "./runStatus";

// Handle needs a live ReactFlow store; the node's own markup is what's under test.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
}));

import { DagNode, isDimmed, type DagNodeData } from "./nodes";
import { ViewContext, type ViewState } from "./viewContext";

const data = (label: string, extra: Partial<DagNodeData> = {}): DagNodeData => ({
  label, layer: "staging", materialized: "", testCount: 0, ...extra,
});

afterEach(cleanup);

describe("DagNode label wrapping", () => {
  it("keeps the box at its layout size and wraps/clamps long snake_case names", () => {
    const long = "rpt_unearned_subscription_revenue_rollforward_detail";
    render(<DagNode id="n1" data={data(long)} />);
    const label = screen.getByText(long);
    // Wraps anywhere (names have no spaces) and clips past two lines.
    expect(label).toHaveStyle({ overflowWrap: "anywhere", overflow: "hidden" });
    expect(label.style.webkitLineClamp).toBe("2");
    // The box itself stays at the size dagre laid out (no overlap growth)…
    const box = label.parentElement!;
    expect(box).toHaveStyle({ width: "180px", height: "44px", boxSizing: "border-box" });
    // …and the full name stays reachable via the tooltip.
    expect(box).toHaveAttribute("title", long);
  });
});

describe("DagNode corner badges", () => {
  it("shows materialization bottom-left and the test count bottom-right", () => {
    render(<DagNode id="n1" data={data("m", { materialized: "table", testCount: 3 })} />);
    const mat = screen.getByText("table");
    expect(mat).toHaveStyle({ position: "absolute" });
    expect(mat.style.left).not.toBe("");   // pinned to the LEFT corner
    expect(mat.style.bottom).not.toBe("");
    const badge = screen.getByLabelText("3 tests");
    expect(badge).toHaveTextContent("3");
    expect(badge).toHaveStyle({ position: "absolute" });
    expect(badge.style.right).not.toBe(""); // pinned to the RIGHT corner
    expect(badge).toHaveAttribute("title", "3 tests");
  });

  it("hides both corners when there is nothing to show", () => {
    render(<DagNode id="n1" data={data("m")} />);
    expect(screen.queryByText("table")).toBeNull();
    expect(screen.queryByLabelText(/tests/)).toBeNull();
  });

  it("singular test tooltip reads '1 test'", () => {
    render(<DagNode id="n1" data={data("m", { testCount: 1 })} />);
    expect(screen.getByLabelText("1 tests")).toHaveAttribute("title", "1 test");
  });
});

describe("DagNode search highlight", () => {
  const withSearch = (label: string, search: string) =>
    render(
      <ViewContext.Provider value={{ selected: null, active: null, up: new Set(), down: new Set(), matched: null, spotlight: null, filtered: null, search, favorites: new Set(), onToggleFavorite: () => {}, runStatus: null }}>
        <DagNode id="n1" data={data(label)} />
      </ViewContext.Provider>,
    );

  it("marks every occurrence of the query in the label", () => {
    withSearch("dim_orders", "dim_ord");
    const mark = screen.getByText("dim_ord");
    expect(mark.tagName).toBe("MARK");
    // The rest of the label survives around the mark.
    expect(mark.parentElement).toHaveTextContent("dim_orders");
  });

  it("is case-insensitive and rings the node box", () => {
    withSearch("DIM_Orders", "dim_ord");
    const mark = screen.getByText("DIM_Ord");
    expect(mark.tagName).toBe("MARK");
    const box = screen.getByTitle("DIM_Orders");
    expect(box.style.boxShadow).toContain("#fbbf24");
  });

  it("renders plain text when the query does not match", () => {
    withSearch("stg_users", "dim_ord");
    expect(screen.getByText("stg_users").tagName).not.toBe("MARK");
    expect(document.querySelector("mark")).toBeNull();
  });
});

describe("DagNode open-model emphasis", () => {
  const withView = (id: string, view: Partial<ViewState>) =>
    render(
      <ViewContext.Provider
        value={{ selected: null, active: null, up: new Set(), down: new Set(), matched: null, spotlight: null, filtered: null, search: "", favorites: new Set(), onToggleFavorite: () => {}, runStatus: null, ...view }}
      >
        <DagNode id={id} data={data("dim_date")} />
      </ViewContext.Provider>,
    );

  it("rings the OPEN model with a white ring + glow (no text label)", () => {
    withView("n1", { active: "n1" });
    const box = screen.getByTitle("dim_date (open)");
    expect(box.style.boxShadow).toContain("#e5e7eb"); // white ring
    expect(box.style.boxShadow).toContain("18px");    // glow
    expect(screen.queryByText("open")).toBeNull();
  });

  it("never dims the open model, even outside the clicked node's lineage", () => {
    // n1 is active but not in n2's lineage → would dim if not for the guard.
    withView("n1", { active: "n1", selected: "n2", up: new Set(), down: new Set() });
    expect(screen.getByTitle("dim_date (open)")).toHaveStyle({ opacity: "1" });
  });

  it("leaves non-active nodes unmarked", () => {
    withView("n1", { active: "n2" });
    expect(screen.queryByTitle("dim_date (open)")).toBeNull();
    expect(screen.getByTitle("dim_date")).toBeInTheDocument();
  });
});

describe("DagNode label stripes", () => {
  it("renders a left-edge stripe per label color", () => {
    const view = {
      selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
      matched: null, search: "", spotlight: null, filtered: null,
      favorites: new Set<string>(), onToggleFavorite: () => {}, runStatus: null,
    };
    const { container } = render(
      <ViewContext.Provider value={view}>
        <DagNode id="n" data={{ label: "n", layer: "model", materialized: "", testCount: 0, labelColors: ["#ef4444", "#22c55e"] }} />
      </ViewContext.Provider>,
    );
    const stripes = container.querySelectorAll('[data-label-stripe]');
    expect(stripes).toHaveLength(2);
    expect((stripes[0] as HTMLElement).style.background).toBe("rgb(239, 68, 68)");
  });
});

describe("DagNode spotlight dimming", () => {
  it("dims a node that is not in the spotlight set", () => {
    const view = {
      selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
      matched: null, search: "", spotlight: new Set<string>(["keepme"]), filtered: null,
      favorites: new Set<string>(), onToggleFavorite: () => {}, runStatus: null,
    };
    const { container } = render(
      <ViewContext.Provider value={view}>
        <DagNode id="other" data={{ label: "other", layer: "model", materialized: "", testCount: 0 }} />
      </ViewContext.Provider>,
    );
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.opacity).toBe("0.18");
  });
});

describe("DagNode label-filter dimming", () => {
  it("dims a node not in the label-filter set", () => {
    const view = {
      selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
      matched: null, search: "", spotlight: null, filtered: new Set<string>(["keep"]),
      favorites: new Set<string>(), onToggleFavorite: () => {}, runStatus: null,
    };
    const { container } = render(
      <ViewContext.Provider value={view}>
        <DagNode id="other" data={{ label: "other", layer: "model", materialized: "", testCount: 0 }} />
      </ViewContext.Provider>,
    );
    expect((container.firstElementChild as HTMLElement).style.opacity).toBe("0.18");
  });
});

describe("isDimmed", () => {
  const base = { selected: null, active: null, up: new Set<string>(), down: new Set<string>(), matched: null, spotlight: null, filtered: null };
  it("open model is never dimmed", () => {
    expect(isDimmed("m", { ...base, active: "m", filtered: new Set(["x"]) })).toBe(false);
  });
  it("filter dims non-members", () => {
    expect(isDimmed("m", { ...base, filtered: new Set(["x"]) })).toBe(true);
    expect(isDimmed("x", { ...base, filtered: new Set(["x"]) })).toBe(false);
  });
  it("spotlight and filter compose", () => {
    expect(isDimmed("m", { ...base, spotlight: new Set(["m"]), filtered: new Set(["x"]) })).toBe(true);
  });
});

describe("DagNode favorites", () => {
  it("renders a filled ★ for a favorited node and toggles on click", () => {
    const toggled: string[] = [];
    const view = {
      selected: null, active: null, up: new Set<string>(), down: new Set<string>(),
      matched: null, spotlight: null, filtered: null, search: "",
      favorites: new Set<string>(["n"]), onToggleFavorite: (id: string) => toggled.push(id), runStatus: null,
    };
    const { getByLabelText } = render(
      <ViewContext.Provider value={view}>
        <DagNode id="n" data={{ label: "n", layer: "model", materialized: "", testCount: 0 }} />
      </ViewContext.Provider>,
    );
    const star = getByLabelText("unfavorite");
    expect(star.textContent).toBe("★");
    fireEvent.click(star);
    expect(toggled).toEqual(["n"]);
  });
});

describe("DagNode run status pilot light", () => {
  const withStatus = (status?: Status) => {
    const view: ViewState = {
      selected: null, active: null, up: new Set(), down: new Set(),
      matched: null, spotlight: null, filtered: null, search: "",
      favorites: new Set(), onToggleFavorite: () => {},
      runStatus: status ? new Map([["n", status]]) : null,
    };
    return render(
      <ViewContext.Provider value={view}>
        <DagNode id="n" data={data("n")} />
      </ViewContext.Provider>,
    );
  };

  it("defaults to a grey idle marble when the node has no run status (always shown, not hidden)", () => {
    withStatus();
    const marble = screen.getByLabelText("run status: idle");
    expect(marble).toHaveAttribute("data-run-status", "idle");
    expect(marble.style.background).toContain("148, 163, 184");
    expect(marble.style.animation).toBe("");
  });

  it("renders a blinking marble while running", () => {
    withStatus("running");
    const marble = screen.getByLabelText("run status: running");
    expect(marble).toHaveAttribute("data-run-status", "running");
    expect(marble.style.animation).toContain("dol-run-blink");
    expect(marble.style.background).toContain("249, 115, 22");
  });

  it("renders a neon-green marble on success (static, no animation)", () => {
    const marble = withStatus("success").getByLabelText("run status: success");
    expect(marble.style.background).toContain("57, 255, 20");
    expect(marble.style.animation).toBe("");
  });

  it("renders a deep-red marble on failure", () => {
    expect(withStatus("failed").getByLabelText("run status: failed").style.background).toContain("220, 38, 38");
  });

  it("renders an amber marble when skipped", () => {
    expect(withStatus("skipped").getByLabelText("run status: skipped").style.background).toContain("245, 158, 11");
  });

  it("has no border, inset in the upper-left corner (mirrors the ☆ favorite)", () => {
    const marble = withStatus("success").getByLabelText("run status: success");
    expect(marble.style.border).toBe("");
    expect(marble.style.left).toBe("8px");
    expect(marble.style.top).toBe("4px");
  });

  it("never renders on a source, even with an explicit status — dbt never runs a source directly", () => {
    const view: ViewState = {
      selected: null, active: null, up: new Set(), down: new Set(),
      matched: null, spotlight: null, filtered: null, search: "",
      favorites: new Set(), onToggleFavorite: () => {},
      runStatus: new Map([["n", "success"]]),
    };
    render(
      <ViewContext.Provider value={view}>
        <DagNode id="n" data={data("n", { layer: "source" })} />
      </ViewContext.Provider>,
    );
    expect(screen.queryByLabelText(/run status/)).toBeNull();
  });
});
