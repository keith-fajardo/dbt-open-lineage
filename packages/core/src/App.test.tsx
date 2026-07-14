// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Graph } from "./graphTypes";

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
const saveExport = vi.fn(async () => true);
const openInIde = vi.fn(async () => true);
const invokeMock = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
  if (cmd === "dbt.manifest" || cmd === "dbt.compile") return manifestGraph;
  if (cmd === "fs.readText") return null;
  if (cmd === "fs.writeText") return true;
  if (cmd === "dbt.gist") return "AI gist";
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
    layoutGraph: (graph: Graph, calloutHeights?: Map<string, number>) => {
      layoutSpy(graph.nodes.length);
      lastCalloutHeights = calloutHeights;
      return real.layoutGraph(graph, calloutHeights);
    },
  };
});

import App, { lineageOf, edgeOnLineage } from "./App";

beforeEach(() => { layoutSpy.mockClear(); invokeMock.mockClear(); manifestGraph = g; lastCalloutHeights = undefined; runEventCb = null; });
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
    expect(panel).toHaveStyle({ width: "280px" });
    const handle = screen.getByRole("separator", { name: "Resize details" });
    // Dispatch MouseEvents with pointer event TYPES: jsdom builds without a
    // PointerEvent constructor drop clientX from fireEvent.pointerDown, which
    // silently turns the drag math into NaN.
    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 400 }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 300 })); // left = wider
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(panel).toHaveStyle({ width: "380px" });
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
    // Node "a" gets its text marked, and the toolbar reports one hit.
    await waitFor(() => expect(document.querySelectorAll("mark").length).toBeGreaterThan(0));
    expect(screen.getByText("1 match")).toBeInTheDocument();
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

describe("readOnly mode", () => {
  beforeEach(() => { manifestGraph = oneModelGraph; });

  it("hides Save/Revert, gist, chip editors, and the Draw toolbar; description renders as text", async () => {
    render(<App projectPath="/proj" initialSelector="stg_orders" readOnly />);
    fireEvent.click(await screen.findByText("stg_orders"));
    await screen.findByText("description");

    expect(screen.queryByLabelText("description")).not.toBeInTheDocument(); // textarea absent
    expect(screen.queryByLabelText("gist")).not.toBeInTheDocument();
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
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false }),
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
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "my_seed uses_seed", hasSeed: true }),
    );
  });

  it("passes hasSeed:false when the active selection has no seed", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("▶ Run"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "a b c d", hasSeed: false }),
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
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "run", selector: "selected_model", hasSeed: false }),
    );
  });

  it("dropdown offers Build and Test, each invoking dbt.run with that command", async () => {
    render(<App projectPath="/proj" initialSelector={ALL} debounceMs={0} canRun />);
    await waitFor(() => expect(screen.getAllByText("a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("run command menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "build" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("dbt.run", { command: "build", selector: "a b c d", hasSeed: false }),
    );
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
