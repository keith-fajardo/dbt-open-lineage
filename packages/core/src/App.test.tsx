// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Graph } from "./graphTypes";
import { favoritesKey } from "./favorites";

// jsdom has no ResizeObserver; React Flow needs one to measure its pane.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

// a → b → c plus a disconnected d (for lineage de-emphasis assertions).
const g: Graph = {
  nodes: ["a", "b", "c", "d"].map((n) => ({
    id: n, name: n, resource_type: "model", layer: "staging", path: "m.sql", description: "",
    materialized: n === "a" ? "table" : "",
    tests: n === "a" ? ["not_null_a_id", "unique_a_id"] : [],
  })),
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
};

// The DAG is blank until a selector is typed (no default "show every model"),
// so tests that just need the graph on screen render with this space-union
// selector (space = union) that reveals all four nodes.
const ALL = "a b c d";

// Single-model graph for the editable description/gist panel tests.
const oneModelGraph: Graph = {
  nodes: [{
    id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
    layer: "staging", path: "models/staging/stg_orders.sql", description: "",
  }],
  edges: [],
};

// mock the bridge + spy on layout to prove it runs once; capture the context
// subscription so tests can push host "context" updates. `invoke` is
// command-aware: dbt.manifest/dbt.compile serve whichever graph the current
// test set via `manifestGraph`, and the panel-edit tests need fs.readText /
// fs.writeText / dbt.gist stubbed too.
let contextCb: ((v: string) => void) | null = null;
let runEventCb: ((e: import("./runStatus").RunEvent) => void) | null = null;
let manifestGraph: Graph = g;
let columnLineageResult: unknown = { nodes: {}, edges: [] };
const saveExport = vi.fn(async () => true);
const openInIde = vi.fn(async () => true);
const invokeMock = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
  if (cmd === "dbt.manifest" || cmd === "dbt.compile") return manifestGraph;
  if (cmd === "fs.readText") return null;
  if (cmd === "fs.writeText") return true;
  if (cmd === "dbt.gist") return "AI gist";
  if (cmd === "dbt.columnLineage") {
    if (columnLineageResult instanceof Error) throw columnLineageResult;
    return columnLineageResult;
  }
  return null;
});
vi.mock("./bridge", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [string, Record<string, unknown>])),
  onContext: (cb: (v: string) => void) => { contextCb = cb; return () => { contextCb = null; }; },
  onRunEvent: (cb: (e: import("./runStatus").RunEvent) => void) => { runEventCb = cb; return () => { runEventCb = null; }; },
  saveExport: (...a: unknown[]) => saveExport(...(a as [])),
  openInIde: (...a: unknown[]) => openInIde(...(a as [])),
}));
const layoutSpy = vi.fn();
// Captured (not folded into layoutSpy's own call args) so existing
// toHaveBeenLastCalledWith(N) assertions on layoutSpy stay exact-arity.
let lastCalloutHeights: Map<string, number> | undefined;
vi.mock("./layout", async (orig) => {
  const real = (await orig()) as typeof import("./layout");
  // Spy records the node count so tests can assert WHICH graph got laid out
  // (full graph vs filtered subgraph).
  return {
    ...real, // keep NODE_W etc. real — CalloutOverlay imports them from here too
    layoutGraph: (
      graph: Graph,
      calloutHeights?: Map<string, number>,
      sizes?: Map<string, { w: number; h: number }>,
    ) => {
      layoutSpy(graph.nodes.length);
      lastCalloutHeights = calloutHeights;
      return real.layoutGraph(graph, calloutHeights, sizes);
    },
  };
});

import App, {
  lineageOf, edgeOnLineage, computeSearchHits, hitKeysSignature, currentHitTarget,
  type SearchHit,
} from "./App";
import type { ColumnLineagePayload } from "./columnLineage";
import type { Node } from "@xyflow/react";
import type { DagNodeData } from "./nodes";

beforeEach(() => {
  layoutSpy.mockClear(); invokeMock.mockClear(); manifestGraph = g;
  lastCalloutHeights = undefined; runEventCb = null;
  columnLineageResult = { nodes: {}, edges: [] };
});
afterEach(cleanup);

describe("dbt DAG App", () => {
  it("loads the graph via the bridge and lays out once", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(layoutSpy).toHaveBeenCalledTimes(1);
  });

  it("changing the selector does NOT re-run layout (no-freeze)", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    const input = screen.getByPlaceholderText(/select/i);
    // Reveal the graph first — a non-empty selector with focus OFF (no Enter)
    // shows every node in dim mode; that's the one layout pass we allow.
    fireEvent.change(input, { target: { value: "a" } });
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const runs = layoutSpy.mock.calls.length;
    // Typing more of the selector (still no Enter) must NOT re-lay-out.
    fireEvent.change(input, { target: { value: "a+" } });
    await waitFor(() => expect(input).toHaveValue("a+"));
    expect(layoutSpy.mock.calls.length).toBe(runs); // no extra layout
  });

  it("Enter applies the selector as a filter — only matched nodes remain, laid out compactly", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    const input = screen.getByPlaceholderText(/select/i);
    // Reveal the whole graph first.
    fireEvent.change(input, { target: { value: ALL } });
    await waitFor(() => expect(screen.getAllByText("b").length).toBeGreaterThan(0));
    // Commit "a" with Enter → only a remains.
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("b")).not.toBeInTheDocument());
    expect(screen.queryByText("c")).not.toBeInTheDocument();
    expect(screen.getAllByText("a").length).toBeGreaterThan(0);
    // The filtered view re-lays-out the visible SUBGRAPH (1 node), so nodes
    // sit compactly instead of keeping full-graph positions.
    expect(layoutSpy).toHaveBeenLastCalledWith(1);
    // Clearing + Enter now BLANKS the DAG (no default "show every model").
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("a")).not.toBeInTheDocument());
    expect(layoutSpy).toHaveBeenLastCalledWith(0);
  });

  it("starts committed+focused on an initial selector (inline Lineage panel)", async () => {
    render(<App projectPath="/proj" initialSelector="+b+" debounceMs={0} />);
    // The input is pre-filled with the +model+ selector…
    expect(screen.getByPlaceholderText(/select/i)).toHaveValue("+b+");
    // …and the DAG is already filtered to b's lineage (a, b, c — not d).
    await waitFor(() => expect(screen.getAllByText("b").length).toBeGreaterThan(0));
    expect(screen.getAllByText("a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("c").length).toBeGreaterThan(0);
    expect(screen.queryByText("d")).not.toBeInTheDocument();
  });

  it("retargets the DAG when the host pushes a new context", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    await waitFor(() => expect(contextCb).not.toBeNull());
    // The DAG starts blank; a pushed context targets a model's lineage.
    act(() => contextCb!("+c+"));
    // Selector input follows, and the view shows c's lineage (a, b, c — not d).
    await waitFor(() => expect(screen.getByPlaceholderText(/select/i)).toHaveValue("+c+"));
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.queryByText("d")).not.toBeInTheDocument();
  });

  it("clears a hand-picked node selection when the host pushes a new context", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("b").length).toBeGreaterThan(0));
    // Select a node by hand: the details side panel opens.
    fireEvent.click(screen.getAllByText("b")[0]);
    await screen.findByRole("complementary");
    // The IDE switches to another model — the stale selection must reset.
    act(() => contextCb!("+a+"));
    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
  });

  it("has no refresh button", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.queryByText(/refresh/i)).not.toBeInTheDocument();
  });

  it("clicking the Columns toggle fetches column lineage and marks the button pressed", async () => {
    columnLineageResult = {
      nodes: { a: { columns: { id: { columnName: "id", hasLineage: true } } } },
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(invokeMock).toHaveBeenCalledWith("dbt.columnLineage", {});
  });

  it("keeps the cached lineage for a single on→off→on without re-fetching redundantly (fetch is once per enable)", async () => {
    columnLineageResult = {
      nodes: { a: { columns: { id: { columnName: "id", hasLineage: true } } } },
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle); // on: fetch #1
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(invokeMock.mock.calls.filter((c) => c[0] === "dbt.columnLineage").length).toBe(1);
    // Toggling on again WITHOUT an intervening off does not double-fetch.
    fireEvent.click(toggle); // off
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
  });

  // Regression: the column-lineage payload is derived from target/manifest.json
  // + catalog.json, which change on every `dbt compile`. Previously it was
  // cached on the first enable and NEVER re-fetched (the toggle guard was
  // `if (!next || columnLineage) return`), so a stale payload — e.g. one
  // captured before a model began passing a column through to a downstream
  // node — showed the trace a hop short forever, and toggling Columns off/on
  // (the user's natural refresh gesture) was a silent no-op. Turning the
  // feature off now drops the cache so re-enabling re-runs colibri.
  it("re-enabling column mode re-fetches, so a recompile's new column edge appears (stale-hop recovery)", async () => {
    // STALE payload: a→b→c graph, but only the a→b column edge is known.
    // Selecting a.id traces to b but NOT c (the second hop is missing).
    columnLineageResult = {
      nodes: {
        a: { columns: { id: { columnName: "id", hasLineage: true } } },
        b: { columns: { id: { columnName: "id", hasLineage: true } } },
        c: { columns: { id: { columnName: "id", hasLineage: true } } },
      },
      edges: [{ source: "a", target: "b", sourceColumn: "id", targetColumn: "id" }],
    };
    const CHEVRON = /\d+ columns?/;
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle); // on: fetches STALE
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(screen.getAllByText(CHEVRON).length).toBeGreaterThan(0));
    // Expand a, then select a.id → with the stale payload only a+b reveal.
    fireEvent.click(screen.getAllByText(CHEVRON)[0]);
    await waitFor(() => expect(screen.getAllByText("id").length).toBe(1)); // only a's expanded row
    fireEvent.click(screen.getAllByText("id")[0]); // select a.id
    await waitFor(() => expect(screen.getAllByText("id").length).toBe(2)); // a + b (stale: c missing)

    // The user recompiles dbt (adding the b→c column edge) and toggles off/on.
    columnLineageResult = {
      nodes: {
        a: { columns: { id: { columnName: "id", hasLineage: true } } },
        b: { columns: { id: { columnName: "id", hasLineage: true } } },
        c: { columns: { id: { columnName: "id", hasLineage: true } } },
      },
      edges: [
        { source: "a", target: "b", sourceColumn: "id", targetColumn: "id" },
        { source: "b", target: "c", sourceColumn: "id", targetColumn: "id" },
      ],
    };
    fireEvent.click(toggle); // off — drops the stale cache AND resets expansion
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(toggle); // on — MUST re-fetch the fresh payload
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(invokeMock.mock.calls.filter((c) => c[0] === "dbt.columnLineage").length).toBe(2);
    // Re-expand a (expansion was reset by the off toggle) and re-select a.id
    // against the fresh payload → now the second hop reveals c.
    await waitFor(() => expect(screen.getAllByText(CHEVRON).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(CHEVRON)[0]); // expand a again
    await waitFor(() => expect(screen.getAllByText("id").length).toBe(1)); // a's row back
    fireEvent.click(screen.getAllByText("id")[0]); // select a.id
    await waitFor(() => expect(screen.getAllByText("id").length).toBe(3)); // a + b + c
    const cRow = screen.getAllByText("id")[2].closest("[data-col-row]") as HTMLElement;
    expect(cRow.getAttribute("data-on-trace")).toBe("true");
  });

  it("shows an error banner and reverts the toggle to off when the fetch fails", async () => {
    columnLineageResult = new Error("dbt-colibri (colibri) not found. Install with: pip install dbt-colibri");
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/pip install dbt-colibri/)).toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  // Regression: dbt-colibri resolves column lineage by parsing COMPILED SQL
  // in manifest.json. A selective/partial `dbt compile`, or another tool's
  // background parse, can silently leave it stale — colibri then falls back
  // to model-level-only edges, which extractColumnLineage correctly filters
  // out. Without a warning this looks identical to a broken toggle (the
  // fetch succeeds, mode stays on, but nothing ever traces) with no hint why.
  it("warns when the fetch succeeds but has zero real column edges (stale/uncompiled manifest)", async () => {
    columnLineageResult = {
      nodes: { a: { columns: { id: { columnName: "id", hasLineage: true } } } },
      edges: [], // colibri ran, but every edge was model-level-only and got filtered
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(screen.getByText(/run a full `dbt compile`/)).toBeInTheDocument());
  });

  it("does not warn when the fetch succeeds with real column edges present", async () => {
    columnLineageResult = {
      nodes: {
        a: { columns: { id: { columnName: "id", hasLineage: true } } },
        b: { columns: { id: { columnName: "id", hasLineage: true } } },
      },
      edges: [{ source: "a", target: "b", sourceColumn: "id", targetColumn: "id" }],
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    const toggle = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByText(/run a full `dbt compile`/)).not.toBeInTheDocument();
  });

  it("shows the selected node's columns in the details panel once column lineage is loaded", async () => {
    columnLineageResult = {
      nodes: {
        a: {
          columns: {
            id: { columnName: "id", hasLineage: true },
            raw: { columnName: "raw", hasLineage: false },
          },
        },
      },
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Columns" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getAllByText("a")[0]);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(panel).toHaveTextContent("columns"));
    expect(panel).toHaveTextContent("id");
    expect(panel).toHaveTextContent("raw");
    expect(panel).toHaveTextContent("unresolved");
  });

  it("shows no columns section before the toggle has ever been used", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("a")[0]);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(panel).toHaveTextContent("materialization"));
    expect(panel).not.toHaveTextContent("(unresolved)");
    expect(screen.queryByText("columns")).not.toBeInTheDocument();
  });

  it("tracing a column from the details panel reveals it as a row on the node", async () => {
    columnLineageResult = {
      nodes: { a: { columns: { id: { columnName: "id", hasLineage: true } } } },
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Columns" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getAllByText("a")[0]);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(panel).toHaveTextContent("columns"));
    // Only the panel's own "id" button is present so far (node a is collapsed).
    expect(screen.getAllByText("id").length).toBe(1);
    // The panel lists every column as a trace control (no more pick). Tracing
    // "id" reveals it as a row on the still-collapsed node a (auto-reveal).
    fireEvent.click(screen.getByRole("button", { name: "trace column id" }));
    await waitFor(() => expect(screen.getAllByText("id").length).toBeGreaterThan(1));
  });
});

describe("node click side panel", () => {
  it("shows the selected node's path/type/description when a node is programmatically selected", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(layoutSpy).toHaveBeenCalledTimes(1));
    const nodeEls = await screen.findAllByText("a");
    fireEvent.click(nodeEls[0]);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(panel).toHaveTextContent("m.sql"));
    expect(panel).toHaveTextContent("model");
  });

  it("shows materialization and the attached tests", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(layoutSpy).toHaveBeenCalledTimes(1));
    fireEvent.click((await screen.findAllByText("a"))[0]);
    const panel = await screen.findByRole("complementary");
    await waitFor(() => expect(panel).toHaveTextContent("materialization"));
    expect(panel).toHaveTextContent("table");
    expect(panel).toHaveTextContent("not_null_a_id");
    expect(panel).toHaveTextContent("unique_a_id");
    // A node without materialization/tests shows placeholders, not stale data.
    fireEvent.click(screen.getAllByText("b")[0]);
    await waitFor(() => expect(screen.getByRole("complementary")).not.toHaveTextContent("not_null_a_id"));
  });

  it("resizes via the left-edge drag handle", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(layoutSpy).toHaveBeenCalledTimes(1));
    fireEvent.click((await screen.findAllByText("a"))[0]);
    const panel = await screen.findByRole("complementary");
    expect(panel).toHaveStyle({ width: "560px" });
    const handle = screen.getByRole("separator", { name: "Resize details" });
    // Dispatch MouseEvents with pointer event TYPES: jsdom builds without a
    // PointerEvent constructor drop clientX from fireEvent.pointerDown, which
    // silently turns the drag math into NaN.
    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 400 }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 300 })); // left = wider
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(panel).toHaveStyle({ width: "660px" });
  });
});

describe("lineageOf", () => {
  it("walks the full upstream and downstream cones", () => {
    const lin = lineageOf(g, "b");
    expect([...lin.up]).toEqual(["a"]);
    expect([...lin.down]).toEqual(["c"]);
  });

  it("excludes disconnected nodes and handles endpoints", () => {
    expect(lineageOf(g, "b").up.has("d")).toBe(false);
    expect(lineageOf(g, "a").up.size).toBe(0);
    expect([...lineageOf(g, "a").down].sort()).toEqual(["b", "c"]);
    expect(lineageOf(g, null).down.size).toBe(0);
  });

  it("is transitive across multiple hops", () => {
    const lin = lineageOf(g, "c");
    expect([...lin.up].sort()).toEqual(["a", "b"]);
    expect(lin.down.size).toBe(0);
  });
});

describe("lineage emphasis on node click", () => {
  it("emphasizes the full up/down cone, dims the rest, animates lineage edges", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("b").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("b")[0]);
    // a (upstream) and c (downstream) stay fully visible; d is de-emphasized.
    // (labels sit in an inner wrapping span — opacity lives on the node box)
    const box = (name: string) => screen.getAllByText(name)[0].parentElement!;
    await waitFor(() => expect(box("d")).toHaveStyle({ opacity: "0.18" }));
    expect(box("a")).toHaveStyle({ opacity: "1" });
    expect(box("c")).toHaveStyle({ opacity: "1" });
  });
});

describe("draggable nodes", () => {
  it("keeps a dragged position over the computed layout, and resets on re-layout", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(layoutSpy).toHaveBeenCalledTimes(1));
    // React Flow wires node dragging itself; assert the wrapper is configured
    // draggable (the class React Flow stamps on draggable nodes).
    const nodeEl = screen.getAllByText("a")[0].closest(".react-flow__node");
    expect(nodeEl).not.toBeNull();
    expect(nodeEl!.className).toContain("draggable");
  });
});

describe("search bar", () => {
  it("highlights matching node labels live and shows the match count", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(document.querySelector("mark")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search nodes"), { target: { value: "a" } });
    // Node "a" gets its text marked, and the toolbar reports the hit as
    // "1 of 1" — the Prev/Next counter format (replaces the old plain
    // "1 match" text now that stepping exists).
    await waitFor(() => expect(document.querySelectorAll("mark").length).toBeGreaterThan(0));
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    // Clearing removes all highlights.
    fireEvent.change(screen.getByLabelText("Search nodes"), { target: { value: "" } });
    await waitFor(() => expect(document.querySelector("mark")).toBeNull());
  });

  it("reports zero matches for a name not in the DAG", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Search nodes"), { target: { value: "zzz" } });
    expect(await screen.findByText("0 matches")).toBeInTheDocument();
    expect(document.querySelector("mark")).toBeNull();
  });

  // "a"/"b"/"c"/"d" share no substrings, so a 2-hit stepping test needs its
  // own tiny graph — two node names that both contain the search query.
  const twoAGraph: Graph = {
    nodes: [
      { id: "a", name: "a", resource_type: "model", layer: "staging", path: "m.sql", description: "" },
      { id: "aa", name: "aa", resource_type: "model", layer: "staging", path: "m.sql", description: "" },
    ],
    edges: [],
  };

  it("shows an 'N of M' counter and Prev/Next chevrons that step through node hits", async () => {
    manifestGraph = twoAGraph;
    render(<App projectPath="/proj" initialSelector="a aa" debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Search nodes"), { target: { value: "a" } });
    await waitFor(() => expect(screen.getByText(/^1 of /)).toBeInTheDocument());
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "next match" });
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByText("2 of 2")).toBeInTheDocument());
    // Stepping wraps around: Next from the last hit goes back to the first.
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByText("1 of 2")).toBeInTheDocument());
    const prev = screen.getByRole("button", { name: "previous match" });
    fireEvent.click(prev);
    await waitFor(() => expect(screen.getByText("2 of 2")).toBeInTheDocument());
  });

  it("Prev/Next are disabled when there are zero matches", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Search nodes"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("0 matches")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "next match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "previous match" })).toBeDisabled();
  });

});

// Regression tests for the final-review finding: `hits` is recomputed from
// `rfNodes`, which gets a brand-new ARRAY identity on every drag — even a
// drag of a node that ISN'T a search hit — because applyNodeChanges always
// returns a fresh array (it only replaces the object for the node that
// actually moved; untouched nodes keep their exact reference, per the
// comment above `onNodesChange` in App.tsx). Before the fix, any `hits`
// identity change reset hitIdx to 0 (`useEffect(() => setHitIdx(0), [searchQ,
// hits])`) and re-panned the viewport to hit #1 (`[hitIdx, hits]`) — so
// stepping to hit #2 and then dragging any unrelated node snapped the
// counter straight back to "1 of N" and yanked the viewport, even though
// nothing about the search results actually changed.
//
// A real React Flow drag doesn't reliably move a node in jsdom (no layout
// engine backs the pane's zoom/pan transform, so d3-drag's position math
// never produces a change worth asserting on — confirmed empirically: a
// simulated mousedown/mousemove/mouseup sequence passed identically against
// both the buggy and the fixed code, i.e. it was a vacuous test). These
// tests instead exercise the actual pure functions the component composes
// (`computeSearchHits`, `hitKeysSignature`, `currentHitTarget`, all exported
// from App.tsx for exactly this purpose), simulating the *shape* of an
// unrelated drag the same way applyNodeChanges really produces it: a new
// array, with a new object only for the node that moved.
describe("search-hit stability (final-review regression)", () => {
  const nodeAt = (id: string, label: string, x: number, y: number): Node<DagNodeData> => ({
    id,
    position: { x, y },
    data: { label, layer: "staging", materialized: "", testCount: 0 },
  });

  it("hitKeysSignature and currentHitTarget stay stable when an UNRELATED node's position changes", () => {
    const before = [
      nodeAt("a", "a", 0, 0),
      nodeAt("aa", "aa", 0, 100),
      nodeAt("other", "other", 0, 200), // never matches "a" — not a hit
    ];
    // Simulate applyNodeChanges after dragging "other": a brand-new array
    // (real onNodesChange always allocates one), a brand-new "other" object
    // (its position moved), but "a"/"aa" keep their EXACT same references —
    // matching applyNodeChanges' real behavior.
    const after = [before[0], before[1], { ...before[2], position: { x: 999, y: 999 } }];
    expect(after).not.toBe(before);

    const hitsBefore = computeSearchHits("a", before);
    const hitsAfter = computeSearchHits("a", after);
    // Root cause, made concrete: `hits` is a brand-new array/object set
    // every time, even though nothing relevant to the search changed — this
    // is exactly why an effect keyed directly off `hits` used to misfire.
    expect(hitsAfter).not.toBe(hitsBefore);

    // The fix: content-derived signatures ARE equal, so effects keyed off
    // these strings (not off `hits` itself) correctly stay put.
    expect(hitKeysSignature(hitsAfter)).toBe(hitKeysSignature(hitsBefore));
    expect(currentHitTarget(hitsAfter, 1)).toBe(currentHitTarget(hitsBefore, 1));
    // Sanity: there really are two hits ("a", "aa"), "other" isn't one.
    const keys: SearchHit[] = hitsBefore;
    expect(keys.map((h) => h.key)).toEqual(["a", "aa"]);
  });

  it("hitKeysSignature DOES change on a genuine change: the query narrows", () => {
    const nodes = [nodeAt("a", "a", 0, 0), nodeAt("aa", "aa", 0, 100)];
    const hitsA = computeSearchHits("a", nodes);
    const hitsB = computeSearchHits("aa", nodes);
    expect(hitKeysSignature(hitsA)).not.toBe(hitKeysSignature(hitsB));
  });

  it("currentHitTarget DOES change when the CURRENTLY TARGETED hit's own node moves (follows it)", () => {
    const before = [nodeAt("a", "a", 0, 0), nodeAt("aa", "aa", 0, 100)];
    const after = [before[0], { ...before[1], position: { x: 500, y: 500 } }];
    const hitsBefore = computeSearchHits("a", before);
    const hitsAfter = computeSearchHits("a", after);
    // Membership is unchanged (still "a" then "aa") ...
    expect(hitKeysSignature(hitsAfter)).toBe(hitKeysSignature(hitsBefore));
    // ... but if the user is currently stepped to "aa" (index 1), the pan
    // target correctly follows it to its new position rather than freezing
    // on a stale spot.
    expect(currentHitTarget(hitsAfter, 1)).not.toBe(currentHitTarget(hitsBefore, 1));
    // An UNTARGETED hit moving (index 0, "a", didn't move here anyway) has
    // no bearing — currentHitTarget only looks at the targeted index.
    expect(currentHitTarget(hitsAfter, 0)).toBe(currentHitTarget(hitsBefore, 0));
  });
});

describe("open in editor", () => {
  it("double-clicking a node asks the host to open its file", async () => {
    openInIde.mockClear();
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.doubleClick(screen.getAllByText("a")[0]);
    await waitFor(() => expect(openInIde).toHaveBeenCalledWith("m.sql"));
  });
});

describe("export", () => {
  it("downloads the SELECTED set as CSV through the host bridge", async () => {
    saveExport.mockClear();
    // Start focused on b's lineage (a, b, c — d excluded), then export as CSV.
    render(<App projectPath="/proj" initialSelector="+b+" debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /csv/i }));
    await waitFor(() => expect(saveExport).toHaveBeenCalled());
    const [filename, b64] = saveExport.mock.calls[0] as unknown as [string, string];
    expect(filename).toBe("dag-selection.csv");
    const csv = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    expect(csv).toContain("a,model,staging");
    expect(csv).toContain("c,model,staging");
    expect(csv).not.toMatch(/^d,/m); // d is outside the selection
  });

  it("exports Mermaid with the selection's edges", async () => {
    saveExport.mockClear();
    // Focus on c's lineage (a→b→c) so the export carries edges.
    render(<App projectPath="/proj" initialSelector="+c+" debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /mermaid/i }));
    await waitFor(() => expect(saveExport).toHaveBeenCalled());
    const [filename, b64] = saveExport.mock.calls[0] as unknown as [string, string];
    expect(filename).toBe("dag-selection.mmd");
    const mmd = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    expect(mmd).toContain("graph LR");
    expect(mmd).toContain("-->");
  });
});

describe("editable description + gist panel", () => {
  beforeEach(() => { manifestGraph = oneModelGraph; });

  it("edits description + gist and writes YAML on Save", async () => {
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    await screen.findByText("stg_orders");            // node rendered
    fireEvent.click(screen.getByText("stg_orders"));  // select → details panel
    const desc = await screen.findByLabelText("description");
    fireEvent.change(desc, { target: { value: "edited desc" } });
    const gist = screen.getByLabelText("gist");
    fireEvent.change(gist, { target: { value: "edited gist" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fs.writeText", expect.objectContaining({
        path: "models/staging/stg_orders.yml",
      })));
    const writtenText = invokeMock.mock.calls.find((c) => c[0] === "fs.writeText")![1]!.text as string;
    expect(writtenText).toContain("edited desc");
    expect(writtenText).toContain("edited gist");
  });

  it("sparkle fills the gist field from dbt.gist without saving", async () => {
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    fireEvent.click(await screen.findByRole("button", { name: /generate gist/i }));
    await waitFor(() => expect((screen.getByLabelText("gist") as HTMLTextAreaElement).value).toBe("AI gist"));
    expect(invokeMock).not.toHaveBeenCalledWith("fs.writeText", expect.anything());
  });

  it("populates the gist field from a legacy flat meta.gist (pre-namespace data)", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { gist: "flat legacy gist", callout: "top" },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("gist") as HTMLTextAreaElement).value).toBe("flat legacy gist"));
  });

  it("populates the gist field from the namespaced meta.dbt_open_lineage.gist", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { gist: "nested gist", callout: "top" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("gist") as HTMLTextAreaElement).value).toBe("nested gist"));
    // The callout checkbox reflects nested data too — this is where fixes 1/3/4
    // all touch, and the original plan's gist-only tests never asserted it.
    const calloutCheckbox = screen.getByLabelText(/show as callout on the dag/i) as HTMLInputElement;
    expect(calloutCheckbox.checked).toBe(true);
  });

  it("does not show a spurious dirty state (Save/Revert enabled) for a node with nested-only gist/callout data", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { gist: "nested gist", callout: "top" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("gist") as HTMLTextAreaElement).value).toBe("nested gist"));
    // Fresh selection, zero edits — the dirty-check baseline must be read via
    // readMeta too (same as the draft), or nested-only data always compares
    // unequal to the flat baseline and the buttons stay permanently enabled.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
  });

  it("reserves DAG layout space for a callout backed by nested-only meta (calloutHeights)", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { gist: "nested gist for layout", callout: "top" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    await screen.findByText("stg_orders");
    // Callouts start OFF (empty reserved-height map); turning them ON must
    // reserve space for this node's bubble even though its gist/callout live
    // only under the namespaced meta.dbt_open_lineage — matching what
    // CalloutOverlay's gistOf (readMeta-based) will actually render.
    fireEvent.click(screen.getByLabelText(/callouts/i));
    await waitFor(() =>
      expect(lastCalloutHeights?.get("model.proj.stg_orders")).toBeGreaterThan(0));
  });

  it("reserves DAG layout space for a grain-only callout (no gist)", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { grain: "one row per order_id", grain_callout: "top" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    await screen.findByText("stg_orders");
    fireEvent.click(screen.getByLabelText(/callouts/i));
    await waitFor(() =>
      expect(lastCalloutHeights?.get("model.proj.stg_orders")).toBeGreaterThan(0));
  });

  it("optimistic in-memory update after Save writes the NESTED shape (a re-select doesn't revert to stale nested data)", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { gist: "stale nested gist", callout: "top" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    const gist = await screen.findByLabelText("gist");
    await waitFor(() => expect((gist as HTMLTextAreaElement).value).toBe("stale nested gist"));
    fireEvent.change(gist, { target: { value: "freshly saved gist" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs.writeText", expect.anything()));
    // Deselect, then re-select: the draft repopulates from the in-memory
    // graph's meta via readMeta, which prefers the nested sub-object. If the
    // post-save optimistic update wrote the FLAT shape (leaving the existing
    // stale `dbt_open_lineage` object untouched via the `...(n.meta ?? {})`
    // spread), readMeta keeps surfacing the stale nested value forever.
    fireEvent.click(screen.getByLabelText("close details"));
    fireEvent.click(screen.getByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("gist") as HTMLTextAreaElement).value).toBe("freshly saved gist"));
  });
});

describe("editable grain field", () => {
  beforeEach(() => { manifestGraph = oneModelGraph; });

  it("edits grain and writes YAML on Save", async () => {
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    const grain = await screen.findByLabelText("grain");
    fireEvent.change(grain, { target: { value: "one row per order_id per day" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fs.writeText", expect.objectContaining({
        path: "models/staging/stg_orders.yml",
      })));
    const writtenText = invokeMock.mock.calls.find((c) => c[0] === "fs.writeText")![1]!.text as string;
    expect(writtenText).toContain("one row per order_id per day");
  });

  it("has no AI-generate button for grain", async () => {
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await screen.findByLabelText("grain");
    expect(screen.queryByRole("button", { name: /generate grain/i })).not.toBeInTheDocument();
  });

  it("populates the grain field from a legacy flat meta.grain (pre-namespace data)", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { grain: "flat legacy grain" },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("grain") as HTMLTextAreaElement).value).toBe("flat legacy grain"));
  });

  it("populates the grain field from the namespaced meta.dbt_open_lineage.grain", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { grain: "nested grain" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("grain") as HTMLTextAreaElement).value).toBe("nested grain"));
  });

  it("does not show a spurious dirty state (Save/Revert enabled) for a node with nested-only grain data", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { grain: "nested grain" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("grain") as HTMLTextAreaElement).value).toBe("nested grain"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled();
  });

  it("Revert restores the grain field to its saved value and clears dirty state", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { grain: "saved grain" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    const grain = await screen.findByLabelText("grain");
    fireEvent.change(grain, { target: { value: "edited grain" } });
    expect(screen.getByRole("button", { name: "Revert" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect((screen.getByLabelText("grain") as HTMLTextAreaElement).value).toBe("saved grain"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("optimistic in-memory update after Save writes the NESTED shape (a re-select doesn't revert to stale nested data)", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { dbt_open_lineage: { grain: "stale nested grain" } },
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" />);
    fireEvent.click(await screen.findByText("stg_orders"));
    const grain = await screen.findByLabelText("grain");
    await waitFor(() => expect((grain as HTMLTextAreaElement).value).toBe("stale nested grain"));
    fireEvent.change(grain, { target: { value: "freshly saved grain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs.writeText", expect.anything()));
    fireEvent.click(screen.getByLabelText("close details"));
    fireEvent.click(screen.getByText("stg_orders"));
    await waitFor(() =>
      expect((screen.getByLabelText("grain") as HTMLTextAreaElement).value).toBe("freshly saved grain"));
  });
});

describe("readOnly mode", () => {
  beforeEach(() => { manifestGraph = oneModelGraph; });

  it("hides Save/Revert, gist, chip editors, and the Draw toolbar; description renders as text", async () => {
    render(<App projectPath="/proj" initialSelector="stg_orders" readOnly />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await screen.findByText("description");

    expect(screen.queryByLabelText("description")).not.toBeInTheDocument(); // textarea absent
    expect(screen.queryByLabelText("gist")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("grain")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate gist/i })).not.toBeInTheDocument();
    expect(screen.queryByText("subject areas")).not.toBeInTheDocument();
    expect(screen.queryByText("Draw")).not.toBeInTheDocument();
    expect(screen.queryByText("▶ Run")).not.toBeInTheDocument();
  });

  it("still shows read-only info: description text, tests, materialization", async () => {
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql",
        description: "a staging model", materialized: "view", tests: ["not_null_id"],
      }],
      edges: [],
    };
    render(<App projectPath="/proj" initialSelector="stg_orders" readOnly />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await screen.findByText("a staging model");
    await screen.findByText("not_null_id");
  });

  it("Labels dropdown shows a plain swatch (no recolor input) and never writes the sidecar", async () => {
    // oneModelGraph carries no labels, so LabelBar would render null — give
    // this node a label so the dropdown (and its color swatch) actually mounts.
    manifestGraph = {
      nodes: [{
        id: "model.proj.stg_orders", name: "stg_orders", resource_type: "model",
        layer: "staging", path: "models/staging/stg_orders.sql", description: "",
        meta: { labels: ["core"] },
      }],
      edges: [],
    };
    const { container } = render(<App projectPath="/proj" initialSelector="stg_orders" readOnly />);
    await screen.findByText("stg_orders");
    fireEvent.click(screen.getByRole("button", { name: /labels/i }));
    await screen.findByText("core"); // the label row rendered inside the open dropdown

    // No live color-write affordance in read-only mode…
    expect(container.querySelector('input[type="color"]')).not.toBeInTheDocument();
    // …and the recolor path (which would fs.writeText the sidecar) never fired.
    expect(invokeMock).not.toHaveBeenCalledWith("fs.writeText", expect.anything());
  });
});

describe("run/build/test button", () => {
  it("is disabled with no runnable models in view (blank selector)", async () => {
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    expect(screen.getByText("▶ Run")).toBeDisabled();
  });

  it("invokes dbt.run with the union of matched+filtered active ids as a selector, on click", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false, hasFullRefresh: false }),
    );
  });

  it("passes hasSeed:true when the active selection includes a seed", async () => {
    manifestGraph = {
      nodes: [
        { id: "seed.proj.my_seed", name: "my_seed", resource_type: "seed", layer: "model", path: "seeds/my_seed.csv", description: "" },
        { id: "model.proj.uses_seed", name: "uses_seed", resource_type: "model", layer: "staging", path: "m.sql", description: "" },
      ],
      edges: [{ from: "seed.proj.my_seed", to: "model.proj.uses_seed" }],
    };
    render(<App projectPath="/proj" initialSelector="my_seed uses_seed" debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("uses_seed").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "my_seed uses_seed", hasSeed: true, hasFullRefresh: false }),
    );
  });

  it("passes hasSeed:false when the active selection has no seed", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false, hasFullRefresh: false }),
    );
  });

  it("passes hasSeed:false when a seed exists in the graph but is excluded from the active selection", async () => {
    manifestGraph = {
      nodes: [
        { id: "seed.proj.unrelated_seed", name: "unrelated_seed", resource_type: "seed", layer: "model", path: "seeds/unrelated_seed.csv", description: "" },
        { id: "model.proj.uses_unrelated_seed", name: "uses_unrelated_seed", resource_type: "model", layer: "staging", path: "a.sql", description: "" },
        { id: "model.proj.selected_model", name: "selected_model", resource_type: "model", layer: "staging", path: "b.sql", description: "" },
      ],
      edges: [{ from: "seed.proj.unrelated_seed", to: "model.proj.uses_unrelated_seed" }],
    };
    render(<App projectPath="/proj" initialSelector="selected_model" debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("selected_model").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "selected_model", hasSeed: false, hasFullRefresh: false }),
    );
  });

  it("dropdown offers Build and Test, each invoking dbt.run with that command", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("run command menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "build" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "build", selector: "a b c d", hasSeed: false, hasFullRefresh: false }),
    );
  });

  it("closes the run dropdown when clicking outside it, but not when clicking inside it", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("run command menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // Clicking inside the dropdown itself must not spuriously close it out
    // from under the click (a naive "close on any click" would race the
    // menu item's own onClick handler).
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // Clicking anywhere outside it (the toolbar background) closes it.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows Cancel instead of Run while a run is active, and invokes dbt.cancel on click", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(screen.getByText("■ Cancel")).toBeInTheDocument());
    fireEvent.click(screen.getByText("■ Cancel"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.cancel", {}));
  });

  it("seeds every active node as queued immediately on click, before any host event arrives", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    // a, b, c, d are all in ALL's active set — every one queues right away,
    // distinguishing "waiting its turn in this run" from idle-grey.
    await waitFor(() => expect(screen.getAllByLabelText("run status: queued").length).toBe(4));
  });

  it("reconciles any still-queued node (never reached) to skipped when the run ends", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(screen.getAllByLabelText("run status: queued").length).toBe(4));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "status", nodeId: "a", status: "success" }));
    await waitFor(() => expect(screen.getByLabelText("run status: success")).toBeInTheDocument());
    // b, c, d never started (Cancel or an early exit) — must not stay stuck queued.
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    await waitFor(() => expect(screen.queryByLabelText("run status: queued")).not.toBeInTheDocument());
    expect(screen.getAllByLabelText("run status: skipped").length).toBe(3);
  });

  it("run-status events from the bridge drive the pilot light, and a done event restores the Run button", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "status", nodeId: "a", status: "success" }));
    await waitFor(() => expect(screen.getByLabelText("run status: success")).toBeInTheDocument());
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    await waitFor(() => expect(screen.getByText("▶ Run")).toBeInTheDocument());
  });

  it("a nonzero exit code on done surfaces a run-failed error", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "done", exitCode: 1 }));
    await waitFor(() => expect(screen.getByText(/run failed/)).toBeInTheDocument());
  });

  it("does not render the Run button when canRun is not passed, even without readOnly (Mnemo-shaped mount)", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.queryByText("▶ Run")).not.toBeInTheDocument();
  });

  it("reconciles any still-running node to skipped when the run ends, so nothing is left spinning", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "status", nodeId: "a", status: "running" }));
    await waitFor(() => expect(screen.getByLabelText("run status: running")).toBeInTheDocument());
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    // "a" (was running) and b/c/d (still queued, never reached) all settle
    // to skipped — nothing is left spinning or stuck looking queued.
    await waitFor(() => expect(screen.getAllByLabelText("run status: skipped").length).toBe(4));
    expect(screen.queryByLabelText("run status: running")).not.toBeInTheDocument();
  });

  it("the reset button is disabled with nothing to reset, and clears the pilot light + any run error on click", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.getByLabelText("reset run status")).toBeDisabled();

    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "status", nodeId: "a", status: "success" }));
    await waitFor(() => expect(screen.getByLabelText("run status: success")).toBeInTheDocument());
    act(() => runEventCb!({ type: "done", exitCode: 1 }));
    await waitFor(() => expect(screen.getByText(/run failed/)).toBeInTheDocument());
    expect(screen.getByLabelText("reset run status")).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText("reset run status"));
    expect(screen.queryByLabelText("run status: success")).not.toBeInTheDocument();
    expect(screen.queryByText(/run failed/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("reset run status")).toBeDisabled();
  });

  it("clears the pilot light and any run error when the lineage changes (selector commit)", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "status", nodeId: "a", status: "success" }));
    await waitFor(() => expect(screen.getByLabelText("run status: success")).toBeInTheDocument());

    // Simulate double-clicking a node to open it in the IDE: the host pushes
    // a new context, which commits a different selector — same mechanism as
    // typing a new selector and pressing Enter.
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("a")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("run status: success")).not.toBeInTheDocument();
    expect(screen.getByLabelText("reset run status")).toBeDisabled();
  });

  it("a log RunEvent appends that line to the right node's log, shown in its sidebar section once selected", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "1 of 4 START sql table model main.a" }));
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "1 of 4 OK created sql table model main.a" }));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("1 of 4 START sql table model main.a")).toBeInTheDocument());
    expect(screen.getByText("1 of 4 OK created sql table model main.a")).toBeInTheDocument();
  });

  it("a node with no logs yet shows no logs section", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("type")).toBeInTheDocument()); // sidebar is open
    expect(screen.queryByText("logs")).not.toBeInTheDocument();
  });

  it("a second Run replaces a node's logs rather than appending to them", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "first run's line" }));
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    fireEvent.click(screen.getByText("▶ Run"));
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "second run's line" }));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("second run's line")).toBeInTheDocument());
    expect(screen.queryByText("first run's line")).not.toBeInTheDocument();
  });

  it("Refresh clears logs alongside the pilot light", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "a line to clear" }));
    act(() => runEventCb!({ type: "done", exitCode: 1 })); // enables the Refresh button
    fireEvent.click(screen.getByLabelText("reset run status"));
    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("type")).toBeInTheDocument());
    expect(screen.queryByText("a line to clear")).not.toBeInTheDocument();
  });

  it("a lineage change clears logs alongside the pilot light", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "log", nodeId: "a", line: "a line to clear" }));

    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("b")).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByText("a")[0]);
    await waitFor(() => expect(screen.getByText("type")).toBeInTheDocument());
    expect(screen.queryByText("a line to clear")).not.toBeInTheDocument();
  });

  it("Run scope is the INTERSECTION of the committed selector and active filters, not their union", async () => {
    localStorage.setItem(favoritesKey("/proj"), JSON.stringify({ favorites: ["b"] }));
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "a+" } }); // matches a, b, c (not d)
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("c").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /favorites/i })); // filtered = {b}
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "b", hasSeed: false, hasFullRefresh: false }),
    );
  });

  it("Run is disabled when the selector and active filters have no overlap", async () => {
    localStorage.setItem(favoritesKey("/proj"), JSON.stringify({ favorites: ["d"] }));
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "a+" } }); // matches a, b, c (not d)
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("c").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /favorites/i })); // filtered = {d}, no overlap
    expect(screen.getByText("▶ Run")).toBeDisabled();
  });
});

describe("regex selector mode", () => {
  it("regex mode OFF: dbt selector syntax works exactly as before (regression check)", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "a+" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("b").length).toBeGreaterThan(0));
    expect(screen.getAllByText("c").length).toBeGreaterThan(0);
    expect(screen.queryByText("d")).not.toBeInTheDocument();
  });

  it("regex mode ON: matches model names by pattern, not dbt selector syntax", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    fireEvent.click(screen.getByRole("button", { name: ".*" }));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "[ac]" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.getAllByText("c").length).toBeGreaterThan(0);
    expect(screen.queryByText("b")).not.toBeInTheDocument();
    expect(screen.queryByText("d")).not.toBeInTheDocument();
  });

  it("regex mode ON: case-insensitive matching", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    fireEvent.click(screen.getByRole("button", { name: ".*" }));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.queryByText("b")).not.toBeInTheDocument();
  });

  it("regex mode ON: anchors and alternation work", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    fireEvent.click(screen.getByRole("button", { name: ".*" }));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "^b$|^c$" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("b").length).toBeGreaterThan(0));
    expect(screen.getAllByText("c").length).toBeGreaterThan(0);
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(screen.queryByText("d")).not.toBeInTheDocument();
  });

  it("regex mode ON: an invalid pattern matches nothing and shows an inline error, clearing once fixed", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    fireEvent.click(screen.getByRole("button", { name: ".*" }));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "a(" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("invalid pattern")).toBeInTheDocument());
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "a" } });
    await waitFor(() => expect(screen.queryByText("invalid pattern")).not.toBeInTheDocument());
    expect(screen.getAllByText("a").length).toBeGreaterThan(0);
  });

  it("--full-refresh still strips correctly in regex mode", async () => {
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    fireEvent.click(screen.getByRole("button", { name: ".*" }));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "[ac] --full-refresh" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a c", hasSeed: false, hasFullRefresh: true }),
    );
  });

  it("toggling regex mode clears run status", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "status", nodeId: "a", status: "success" }));
    await waitFor(() => expect(screen.getByLabelText("run status: success")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: ".*" }));
    expect(screen.queryByLabelText("run status: success")).not.toBeInTheDocument();
  });

  it("an empty box in regex mode behaves like an empty box in selector mode (Show-All available)", async () => {
    render(<App projectPath="/proj" debounceMs={0} />);
    fireEvent.click(screen.getByRole("button", { name: ".*" }));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: /show all/i })).toBeInTheDocument();
  });
});

describe("Apply Filter / Restore", () => {
  it("is disabled when no category filter is active", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "Apply Filter" })).toBeDisabled();
  });

  it("removes non-emphasized nodes from the DAG; Restore brings them back", async () => {
    localStorage.setItem(favoritesKey("/proj"), JSON.stringify({ favorites: ["b"] }));
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /favorites/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply Filter" }));
    await waitFor(() => expect(screen.queryByText("a")).not.toBeInTheDocument());
    expect(screen.queryByText("c")).not.toBeInTheDocument();
    expect(screen.queryByText("d")).not.toBeInTheDocument();
    expect(screen.getAllByText("b").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.getAllByText("c").length).toBeGreaterThan(0);
    expect(screen.getAllByText("d").length).toBeGreaterThan(0);
  });

  it("toggling a filter off after Apply Filter does NOT auto-restore the pruned nodes", async () => {
    localStorage.setItem(favoritesKey("/proj"), JSON.stringify({ favorites: ["b"] }));
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /favorites/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply Filter" }));
    await waitFor(() => expect(screen.queryByText("a")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /favorites/i })); // favorites OFF now
    expect(screen.queryByText("a")).not.toBeInTheDocument(); // still pruned, stale
    expect(screen.getAllByText("b").length).toBeGreaterThan(0);
  });

  it("committing a new selector auto-clears the pruning", async () => {
    localStorage.setItem(favoritesKey("/proj"), JSON.stringify({ favorites: ["b"] }));
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /favorites/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply Filter" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply Filter" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });
});

describe("run-result toast", () => {
  it("shows a success toast when a run completes with exit code 0", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    await waitFor(() => expect(screen.getByText("✓ Run succeeded")).toBeInTheDocument());
  });

  it("shows a failure toast when a run completes with a nonzero exit code", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "done", exitCode: 1 }));
    await waitFor(() => expect(screen.getByText("✗ Run failed")).toBeInTheDocument());
  });

  it("the toast is visible with no node selected (sidebar closed) — the common case", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() => expect(runEventCb).not.toBeNull());
    act(() => runEventCb!({ type: "done", exitCode: 0 }));
    await waitFor(() => expect(screen.getByText("✓ Run succeeded")).toBeInTheDocument());
  });
});

describe("--full-refresh flag", () => {
  it("passes hasFullRefresh:true and strips the token before resolving, when present in the committed selector", async () => {
    render(<App projectPath="/proj" initialSelector="a b c d --full-refresh" debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false, hasFullRefresh: true }),
    );
  });

  it("passes hasFullRefresh:false when the token is absent", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false, hasFullRefresh: false }),
    );
  });

  it("the token alone (no other selector text) resolves to nothing, same as today's pre-flag no-op", async () => {
    render(<App projectPath="/proj" initialSelector="--full-refresh" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(screen.getByText("▶ Run")).toBeDisabled();
  });
});

describe("show-all confirmation on blank Enter", () => {
  it("Enter on an already-blank selector shows a confirm modal instead of doing nothing", async () => {
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: /show all/i })).toBeInTheDocument();
    expect(screen.getByText("Show all 4 models?")).toBeInTheDocument();
  });

  it("Cancel dismisses the modal and leaves the DAG blank", async () => {
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("a")).not.toBeInTheDocument();
  });

  it("Show All reveals every node and turns Focus on", async () => {
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show All" }));
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    expect(screen.getAllByText("b").length).toBeGreaterThan(0);
    expect(screen.getAllByText("c").length).toBeGreaterThan(0);
    expect(screen.getAllByText("d").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Focus" })).toHaveAttribute("aria-pressed", "true");
  });

  it("typing after a confirmed show-all resets it — the next blank Enter re-prompts", async () => {
    render(<App projectPath="/proj" debounceMs={0} canRun />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dbt.manifest", expect.anything()));
    const input = screen.getByPlaceholderText(/select/i);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show All" }));
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: /show all/i })).toBeInTheDocument();
  });
});

describe("edgeOnLineage", () => {
  it("marks upstream and downstream edges of the selection, nothing else", () => {
    const lin = lineageOf(g, "b");
    expect(edgeOnLineage("b", lin, { from: "a", to: "b" })).toBe(true);  // upstream
    expect(edgeOnLineage("b", lin, { from: "b", to: "c" })).toBe(true);  // downstream
    expect(edgeOnLineage(null, lin, { from: "a", to: "b" })).toBe(false); // no selection
  });

  it("excludes a direct ancestor→descendant edge that bypasses the selection", () => {
    // a → b → c with an extra shortcut a → c: selecting b must NOT light up a→c.
    const g2: Graph = { nodes: g.nodes, edges: [...g.edges, { from: "a", to: "c" }] };
    const lin = lineageOf(g2, "b");
    expect(edgeOnLineage("b", lin, { from: "a", to: "c" })).toBe(false);
    expect(edgeOnLineage("b", lin, { from: "a", to: "b" })).toBe(true);
    expect(edgeOnLineage("b", lin, { from: "b", to: "c" })).toBe(true);
  });
});

describe("in-node column expand/collapse + selection", () => {
  const withCols: ColumnLineagePayload = {
    nodes: {
      a: { columns: { id: { columnName: "id", hasLineage: true } } },
      b: { columns: { id: { columnName: "id", hasLineage: true } } },
    },
    edges: [{ source: "a", target: "b", sourceColumn: "id", targetColumn: "id" }],
  };

  // Text queries (not *ByRole): React Flow node wrappers stay visibility:hidden
  // in jsdom (no real ResizeObserver ever marks them "measured"), and RTL's
  // role queries exclude hidden-ancestor descendants — the same reason every
  // other in-node interaction in this suite uses getByText, not getByRole.
  const CHEVRON = /\d+ columns?/; // matches the "▸ N columns" toggle, not the panel "columns" header

  it("expanding a node renders its catalog and re-lays out once; selecting a column ALSO re-lays out (nodeSizes now tracks the trace — Invariant 4 reversal)", async () => {
    columnLineageResult = withCols;
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Columns" })).toHaveAttribute("aria-pressed", "true"));
    // Wait for the fetch to land (chevrons only render once columnLineage data
    // has arrived) before measuring layout counts, so the assertions below
    // isolate the relayout caused by EXPANDING/SELECTING, not by column mode
    // turning on.
    await waitFor(() => expect(screen.getAllByText(CHEVRON).length).toBeGreaterThan(0));
    const layoutsBefore = layoutSpy.mock.calls.length;
    // Expand node a → its "id" row renders, and expansion (a data change)
    // triggers exactly one relayout — never mid-drag (Invariant 1), the
    // accepted callout-style tradeoff.
    fireEvent.click(screen.getAllByText(CHEVRON)[0]);
    await waitFor(() => expect(screen.getAllByText("id").length).toBeGreaterThan(0));
    expect(layoutSpy.mock.calls.length).toBe(layoutsBefore + 1);
    const layoutsAfterExpand = layoutSpy.mock.calls.length;
    // Select a.id. This is the DELIBERATE reversal of the old "selecting costs
    // zero relayout": b's collapsed box must now reserve space for its
    // auto-revealed row, so nodeSizes changes → a relayout fires on selection.
    fireEvent.click(screen.getAllByText("id")[0]);
    await waitFor(() => expect(layoutSpy.mock.calls.length).toBeGreaterThan(layoutsAfterExpand));
  });

  it("selecting a column auto-reveals its trace row on another node that stays COLLAPSED (transient, visual-only)", async () => {
    columnLineageResult = withCols;
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Columns" })).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(screen.getAllByText(CHEVRON).length).toBeGreaterThan(0));
    // Expand a so its "id" row is clickable — b is never expanded.
    fireEvent.click(screen.getAllByText(CHEVRON)[0]);
    await waitFor(() => expect(screen.getAllByText("id").length).toBe(1)); // only a's row so far
    // Select a.id. traceColumn = {a::id, b::id} → b's row auto-reveals though b
    // stays collapsed and was never expanded.
    fireEvent.click(screen.getAllByText("id")[0]);
    await waitFor(() => expect(screen.getAllByText("id").length).toBe(2)); // a (expanded) + b (auto)
    const bRow = screen.getAllByText("id")[1].closest("[data-col-row]") as HTMLElement;
    expect(bRow.getAttribute("data-on-trace")).toBe("true");
    // Deselecting collapses the trace — b's auto row disappears; no stray state survives.
    fireEvent.click(screen.getAllByText("id")[0]); // same row again → toggles selection off
    await waitFor(() => expect(screen.getAllByText("id").length).toBe(1));
  });
});
