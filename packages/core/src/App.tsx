import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ReactFlow, Background, Controls, applyNodeChanges,
  type Node, type Edge, type NodeMouseHandler, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng, toSvg } from "html-to-image";
import type { Graph, GraphNode } from "./graphTypes";
import { invoke, onContext, saveExport, openInIde } from "./bridge";
import { layoutGraph } from "./layout";
import { resolveSelector, focalName } from "./selector";
import { nodeTypes, type DagNodeData } from "./nodes";
import { ViewContext, type ViewState } from "./viewContext";
import { exportScope, toCsv, toMermaid, b64encode } from "./export";
import { targetYamlPath, upsertModelDoc } from "./yamlEdit";
import { parseAnnotations, setSidecarColor, SIDECAR_PATH, EMPTY_ANNOTATIONS, type Annotations } from "./annotations";
import { nodeAreas, nodeLabels, areaMembers } from "./zones";
import { ZonesOverlay } from "./ZonesOverlay";
import { CalloutOverlay } from "./CalloutOverlay";
import { AreaControl } from "./AreaControl";
import { LabelBar } from "./LabelBar";
import { resolveStyles, type Style } from "./styles";

interface Props { projectPath: string; initialSelector?: string; debounceMs?: number }

// The sandboxed iframe gets no font from the host app — without this the DAG
// renders in the user agent's default serif (Times). System UI sans, like the
// IDE's workbench font.
const FONT_UI =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

export interface Lineage { up: Set<string>; down: Set<string> }

/** Full transitive lineage of `id`: every upstream ancestor and downstream
 * descendant, computed straight from graph.edges. */
export function lineageOf(graph: Graph, id: string | null): Lineage {
  const up = new Set<string>();
  const down = new Set<string>();
  if (!id) return { up, down };
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of graph.edges) {
    (children.get(e.from) ?? children.set(e.from, []).get(e.from)!).push(e.to);
    (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
  }
  const walk = (start: string, adj: Map<string, string[]>, out: Set<string>) => {
    const stack = [start];
    while (stack.length) {
      for (const nb of adj.get(stack.pop()!) ?? []) {
        if (!out.has(nb)) { out.add(nb); stack.push(nb); }
      }
    }
  };
  walk(id, parents, up);
  walk(id, children, down);
  return { up, down };
}

/** An edge lies on the selection's lineage exactly when it feeds the upstream
 * cone (its target reaches the selection) or continues the downstream cone
 * (its source is reached from the selection). A direct ancestor→descendant
 * edge that bypasses the selection matches neither. */
export function edgeOnLineage(
  selected: string | null, lineage: Lineage, e: { from: string; to: string },
): boolean {
  return selected != null &&
    (e.to === selected || lineage.up.has(e.to) ||
     e.from === selected || lineage.down.has(e.from));
}

export default function App({ projectPath, initialSelector = "", debounceMs = 150 }: Props) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An initial selector (from the IDE's Lineage panel) starts committed AND
  // focused: the panel shows just the model's lineage, not the whole DAG.
  const [raw, setRaw] = useState(initialSelector);
  const [selector, setSelector] = useState(initialSelector);
  const [focus, setFocus] = useState(initialSelector !== "");
  const [selected, setSelected] = useState<string | null>(null);
  // The model whose file is OPEN in the IDE — the focus of the pushed
  // lineage. Tracked separately from `selected` (a hand-clicked node) and
  // from the typed `selector`, so the open model stays emphasized no matter
  // what the user clicks or types. Seeded from the initial `+model+` push.
  const [activeName, setActiveName] = useState(() => focalName(initialSelector));
  const [search, setSearch] = useState(""); // live node-name search (highlight only)
  const [panelW, setPanelW] = useState(280); // details panel width, drag to resize
  const [descH, setDescH] = useState(72); // description box height, drag handle below
  const [gistH, setGistH] = useState(72); // gist box height, drag handle below

  // Drag a textarea's bottom handle to resize its height. The native CSS resize
  // grip is unreliable in the WKWebView iframe, so drive height from state via
  // the same pointer-capture idiom the panel edge uses.
  const startBoxResize = (setH: (n: number) => void, startH: number) => (e: ReactPointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const move = (ev: PointerEvent) =>
      setH(Math.max(48, Math.min(500, startH + (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Drag the details panel's left edge to resize it (left = wider).
  const startPanelResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    const move = (ev: PointerEvent) =>
      setPanelW(Math.max(200, Math.min(600, startW + (startX - ev.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const load = async (cmd: "dbt.manifest" | "dbt.compile") => {
    setError(null);
    try { setGraph(await invoke<Graph>(cmd, { projectPath })); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };
  useEffect(() => { void load("dbt.manifest"); /* eslint-disable-next-line */ }, []);

  const [annotations, setAnnotations] = useState<Annotations>(EMPTY_ANNOTATIONS);
  useEffect(() => {
    let live = true;
    void invoke<string | null>("fs.readText", { path: SIDECAR_PATH })
      .then((t) => { if (live) setAnnotations(parseAnnotations(t)); })
      .catch(() => { if (live) setAnnotations(EMPTY_ANNOTATIONS); });
    return () => { live = false; };
  }, [projectPath]);

  // Every area key referenced by a node or defined in the sidecar, sorted.
  const allAreas = useMemo(() => {
    const set = new Set<string>(Object.keys(annotations.areas));
    if (graph) for (const n of graph.nodes) for (const a of nodeAreas(n)) set.add(a);
    return [...set].sort();
  }, [graph, annotations]);

  const allLabels = useMemo(() => {
    const set = new Set<string>(Object.keys(annotations.labels));
    if (graph) for (const n of graph.nodes) for (const l of nodeLabels(n)) set.add(l);
    return [...set].sort();
  }, [graph, annotations]);

  const areaStyles = useMemo(() => resolveStyles(annotations.areas, allAreas), [annotations, allAreas]);
  const labelStyles = useMemo(() => resolveStyles(annotations.labels, allLabels), [annotations, allLabels]);

  const [areasVisible, setAreasVisible] = useState<Set<string>>(new Set());
  const [zoneShape, setZoneShape] = useState<"box" | "hull">("box");
  const [spotArea, setSpotArea] = useState<string | null>(null);
  const [showCallouts, setShowCallouts] = useState(true);
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());

  // Default: show every zone once the area list is known (and whenever it grows).
  useEffect(() => { setAreasVisible(new Set(allAreas)); }, [allAreas]);

  // The host pushes a new context whenever the active model changes in the
  // IDE — retarget the DAG exactly as if the user typed it and hit Enter.
  // Any node picked by hand in the old graph is stale now — drop it so the
  // new model's lineage isn't dimmed by a leftover selection.
  useEffect(() => onContext((value) => {
    setRaw(value);
    setSelector(value);
    setFocus(value !== "");
    setSelected(null);
    setActiveName(focalName(value)); // the newly-opened model becomes the focus
  }), []);

  // debounce selector input → no resolve per keystroke
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSelector(raw), debounceMs);
    return () => clearTimeout(timer.current);
  }, [raw, debounceMs]);

  const matched = useMemo(
    () => (graph ? resolveSelector(graph, selector) : new Set<string>()),
    [graph, selector],
  );

  // Unfiltered view: layout runs ONCE per graph (positions keyed on graph
  // identity only — typing a selector just dims, never re-lays-out). With the
  // filter on, lay out the visible SUBGRAPH instead, so the remaining nodes
  // sit compactly together rather than keeping their full-graph positions.
  const visibleGraph = useMemo(() => {
    if (!graph || !focus) return graph;
    return {
      nodes: graph.nodes.filter((n) => matched.has(n.id)),
      edges: graph.edges.filter((e) => matched.has(e.from) && matched.has(e.to)),
    };
  }, [graph, focus, matched]);
  const positioned = useMemo(
    () => (visibleGraph ? layoutGraph(visibleGraph) : new Map()),
    [visibleGraph],
  );

  // Nodes live in STATE, keyed to the layout they were built from. Drags are
  // applied with applyNodeChanges, which preserves the identity of every node
  // object except the one being dragged — rebuilding the whole array per drag
  // frame forces React Flow to re-sync its entire store at 60fps, which
  // breaks node measurement in WKWebView and blanks the graph. A layout
  // change (new graph, selector commit, focus toggle) swaps in fresh
  // positions DURING RENDER, so a remount + fitView never sees stale ones.
  // Selection/dim styling rides in ViewContext, not node data (see nodes.tsx).
  const buildNodes = (): Node<DagNodeData>[] =>
    !graph ? [] : graph.nodes
      .filter((n) => (focus ? matched.has(n.id) : true))
      .map((n) => ({
        id: n.id,
        type: "dag",
        position: positioned.get(n.id) ?? { x: 0, y: 0 },
        data: {
          label: n.name,
          layer: n.layer,
          materialized: n.materialized ?? "",
          testCount: n.tests?.length ?? 0,
          labelColors: nodeLabels(n)
            .map((l) => labelStyles.get(l)?.color)
            .filter((c): c is string => !!c),
        },
      }));
  // Rebuild the node array when the layout OR the resolved label styles change
  // (label colors live in node data). A drag never changes either, so this
  // never rebuilds mid-drag — preserving node identity for React Flow.
  const nodeBuildKey = useMemo(() => ({ positioned, labelStyles }), [positioned, labelStyles]);
  const [nodeState, setNodeState] = useState<{ base: unknown; nodes: Node<DagNodeData>[] }>(
    { base: null, nodes: [] },
  );
  if (nodeState.base !== nodeBuildKey) {
    setNodeState({ base: nodeBuildKey, nodes: buildNodes() }); // derived-state reset during render
  }
  const rfNodes = nodeState.base === nodeBuildKey ? nodeState.nodes : buildNodes();
  const onNodesChange = useCallback((changes: NodeChange[]) =>
    setNodeState((prev) => ({ base: prev.base, nodes: applyNodeChanges(changes, prev.nodes) as Node<DagNodeData>[] })),
  []);

  // Selecting a node never touches layout — style-only, full lineage cone.
  const lineage = useMemo(
    () => (graph ? lineageOf(graph, selected) : { up: new Set<string>(), down: new Set<string>() }),
    [graph, selected],
  );

  const selectedNode: GraphNode | null = useMemo(
    () => (graph && selected ? graph.nodes.find((n) => n.id === selected) ?? null : null),
    [graph, selected],
  );

  // Per-selection edit buffer for the details panel. Reset whenever the
  // selected node changes; nothing hits disk until Save.
  const [descDraft, setDescDraft] = useState("");
  const [gistDraft, setGistDraft] = useState("");
  const [gistBusy, setGistBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null); // transient success pill
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };
  useEffect(() => {
    setDescDraft(selectedNode?.description ?? "");
    setGistDraft(typeof selectedNode?.meta?.gist === "string" ? (selectedNode.meta.gist as string) : "");
    setGistBusy(false);
    setSaveErr(null);
    setToast(null);
  }, [selectedNode]);

  const editable = !!selectedNode && selectedNode.resource_type !== "source";
  const dirty = editable &&
    (descDraft !== (selectedNode!.description ?? "") ||
     gistDraft !== (typeof selectedNode!.meta?.gist === "string" ? selectedNode!.meta!.gist : ""));

  const onSave = async () => {
    if (!selectedNode) return;
    setSaveErr(null);
    try {
      const path = targetYamlPath(selectedNode);
      const existing = await invoke<string | null>("fs.readText", { path });
      const text = upsertModelDoc(existing, selectedNode.name, descDraft, gistDraft);
      await invoke<boolean>("fs.writeText", { path, text });
      // Optimistic in-memory update: the manifest on disk is stale until the
      // next `dbt compile`, but the panel should reflect the save immediately.
      setGraph((g) => g && {
        ...g,
        nodes: g.nodes.map((n) => n.id === selectedNode.id
          ? { ...n, description: descDraft, meta: { ...(n.meta ?? {}), gist: gistDraft } } : n),
      });
      flashToast("✓ Saved to YAML");
    } catch (e) { setSaveErr(String((e as Error).message ?? e)); }
  };

  const onSparkle = async () => {
    if (!selectedNode) return;
    setGistBusy(true); setSaveErr(null);
    try {
      const g = await invoke<string>("dbt.gist", { uniqueId: selectedNode.id, description: descDraft });
      setGistDraft(g.trim());
      flashToast("✨ Gist generated");
    } catch (e) { setSaveErr(String((e as Error).message ?? e)); }
    finally { setGistBusy(false); }
  };

  const onToggleLabel = (label: string) =>
    setLabelFilter((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });

  const onLabelColor = async (label: string, color: string) => {
    // Optimistic: update in-memory styles immediately, then persist the sidecar.
    setAnnotations((a) => ({
      ...a,
      labels: { ...a.labels, [label]: { name: a.labels[label]?.name ?? label, color } },
    }));
    try {
      const existing = await invoke<string | null>("fs.readText", { path: SIDECAR_PATH });
      const text = setSidecarColor(existing, "labels", label, color);
      await invoke<boolean>("fs.writeText", { path: SIDECAR_PATH, text });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  // The graph id of the OPEN model (focal name → node). null when the name
  // matches no node (a source, a method selector, or the standalone window).
  const activeId = useMemo(
    () => (graph && activeName ? graph.nodes.find((n) => n.name === activeName)?.id ?? null : null),
    [graph, activeName],
  );

  // With a node selected, its full lineage (ancestors + descendants) is
  // emphasized and everything else de-emphasized (via ViewContext);
  // lineage edges turn into animated dashes flowing source→target.
  const hasSel = selected != null;
  const searchQ = search.trim().toLowerCase();

  const spotlight = useMemo(
    () => (graph && spotArea ? new Set(areaMembers(graph.nodes, spotArea)) : null),
    [graph, spotArea],
  );

  const filtered = useMemo(() => {
    if (!graph || labelFilter.size === 0) return null;
    return new Set(
      graph.nodes.filter((n) => nodeLabels(n).some((l) => labelFilter.has(l))).map((n) => n.id),
    );
  }, [graph, labelFilter]);

  const view: ViewState = useMemo(() => ({
    selected,
    active: activeId,
    up: lineage.up,
    down: lineage.down,
    // With focus OFF, un-matched nodes dim; with focus ON they're filtered out.
    matched: focus ? null : matched,
    spotlight,
    filtered,
    search: searchQ,
  }), [selected, activeId, lineage, focus, matched, spotlight, filtered, searchQ]);

  // Live match count over the nodes actually shown in the DAG.
  const searchHits = useMemo(() => {
    if (!searchQ) return 0;
    return rfNodes.filter((n) => n.data.label.toLowerCase().includes(searchQ)).length;
  }, [rfNodes, searchQ]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges
      .filter((e) => (focus ? matched.has(e.from) && matched.has(e.to) : true))
      .map((e) => {
        const onLineage = edgeOnLineage(selected, lineage, e);
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          animated: onLineage,
          style: {
            opacity: hasSel
              ? (onLineage ? 0.95 : 0.06)
              : !focus && !(matched.has(e.from) && matched.has(e.to)) ? 0.1 : 0.9,
            stroke: onLineage ? "#e5e7eb" : undefined,
            strokeWidth: onLineage ? 2 : undefined,
          },
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, matched, focus, selected, lineage]);

  const onNodeClick: NodeMouseHandler = (_, n) => setSelected(n.id);
  // Double-click a node → open its model/source file in the IDE editor
  // (no-op in the standalone window, which has no editor to open into).
  const onNodeDoubleClick: NodeMouseHandler = (_, n) => {
    const target = graph?.nodes.find((x) => x.id === n.id);
    if (target?.path) void openInIde(target.path).catch(() => {/* standalone window */});
  };

  // ── Export: the CURRENT SELECTION (matched set) as CSV/Mermaid/SVG/PNG.
  // Files reach disk through the host bridge: native save dialog + Rust
  // write, since a sandboxed iframe cannot download anything itself.
  const [exportMenu, setExportMenu] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const doExport = async (kind: "csv" | "mermaid" | "svg" | "png") => {
    setExportMenu(false);
    setExportErr(null);
    if (!graph) return;
    try {
      const scope = exportScope(graph, matched);
      if (kind === "csv") {
        await saveExport("dag-selection.csv", b64encode(toCsv(scope.nodes)));
        return;
      }
      if (kind === "mermaid") {
        await saveExport("dag-selection.mmd", b64encode(toMermaid(scope)));
        return;
      }
      // Image exports capture the flow viewport, framed on the selection.
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
      if (!viewport) throw new Error("graph not rendered yet");
      const ids = new Set(scope.nodes.map((n) => n.id));
      const shown = rfNodes.filter((n) => ids.has(n.id));
      if (!shown.length) throw new Error("selection matches no visible nodes");
      const xs = shown.map((n) => n.position.x);
      const ys = shown.map((n) => n.position.y);
      const bounds = {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs.map((x) => x + 180)) - Math.min(...xs),
        h: Math.max(...ys.map((y) => y + 44)) - Math.min(...ys),
      };
      const PAD = 40;
      const width = Math.min(4096, Math.ceil(bounds.w + PAD * 2));
      const height = Math.min(4096, Math.ceil(bounds.h + PAD * 2));
      const opts = {
        backgroundColor: "#0b1220",
        width,
        height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${PAD - bounds.x}px, ${PAD - bounds.y}px) scale(1)`,
        },
      };
      const dataUrl = kind === "png" ? await toPng(viewport, opts) : await toSvg(viewport, opts);
      // data:image/png;base64,… stays base64; data:image/svg+xml;charset=utf-8,… is percent-encoded text.
      const b64 = kind === "png"
        ? dataUrl.slice(dataUrl.indexOf(",") + 1)
        : b64encode(decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1)));
      await saveExport(`dag-selection.${kind}`, b64);
    } catch (e) {
      setExportErr(String((e as Error).message ?? e));
    }
  };

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", background: "#0b1220", fontFamily: FONT_UI }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, padding: 8, alignItems: "center" }}>
          <input
            placeholder="select… e.g. stg_orders+ or tag:mart --exclude config.materialized:view  (Enter shows only the selection)"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              // Enter commits the selector: apply it immediately (skip the
              // debounce) and filter the DAG to only the matched nodes. An
              // empty selector matches everything, so clear + Enter restores
              // the full graph.
              if (e.key === "Enter") {
                setSelector(raw);
                setFocus(true);
              }
            }}
            style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #334155", background: "#111827", color: "#e5e7eb", fontFamily: "inherit" }}
          />
          <label style={{ color: "#94a3b8", fontSize: 13 }}>
            <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} /> Focus
          </label>
          <label style={{ color: "#94a3b8", fontSize: 13 }}>
            <input type="checkbox" checked={showCallouts} onChange={(e) => setShowCallouts(e.target.checked)} /> Callouts
          </label>
          <AreaControl
            areas={allAreas}
            styles={areaStyles}
            visible={areasVisible}
            onVisibleChange={setAreasVisible}
            spot={spotArea}
            onSpot={setSpotArea}
            shape={zoneShape}
            onShape={setZoneShape}
          />
          <LabelBar
            labels={allLabels}
            styles={labelStyles}
            filter={labelFilter}
            onToggle={onToggleLabel}
            onColor={(l, c) => void onLabelColor(l, c)}
          />
          <input
            aria-label="Search nodes"
            placeholder="search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 170, padding: "6px 10px", borderRadius: 6, border: "1px solid #334155", background: "#111827", color: "#e5e7eb", fontFamily: "inherit" }}
          />
          {searchQ !== "" && (
            <span style={{ color: searchHits ? "#fbbf24" : "#64748b", fontSize: 12, whiteSpace: "nowrap" }}>
              {searchHits} match{searchHits === 1 ? "" : "es"}
            </span>
          )}
          <div style={{ position: "relative" }}>
            <button
              aria-haspopup="menu"
              aria-expanded={exportMenu}
              onClick={() => setExportMenu((v) => !v)}
              style={{
                padding: "6px 10px", borderRadius: 6, border: "1px solid #334155",
                background: "#111827", color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 13,
              }}
            >Export ▾</button>
            {exportMenu && (
              <div
                role="menu"
                style={{
                  position: "absolute", right: 0, top: "110%", zIndex: 20, minWidth: 150,
                  background: "#111827", border: "1px solid #334155", borderRadius: 6, overflow: "hidden",
                }}
              >
                {([
                  ["csv", "List (CSV)"],
                  ["mermaid", "Mermaid (.mmd)"],
                  ["svg", "Image (SVG)"],
                  ["png", "Image (PNG)"],
                ] as const).map(([kind, label]) => (
                  <button
                    key={kind}
                    role="menuitem"
                    onClick={() => void doExport(kind)}
                    style={{
                      display: "block", width: "100%", textAlign: "left", padding: "7px 12px",
                      background: "none", border: "none", color: "#e5e7eb", cursor: "pointer",
                      fontFamily: "inherit", fontSize: 13,
                    }}
                  >{label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
        {error && <div style={{ color: "#fca5a5", padding: 8 }}>{error}</div>}
        {exportErr && <div style={{ color: "#fca5a5", padding: 8 }}>export failed: {exportErr}</div>}
        <div style={{ flex: 1 }}>
          <ViewContext.Provider value={view}>
          <ReactFlow
            // Remount when the committed filter changes so fitView re-frames
            // the (re-laid-out) visible subgraph.
            key={focus ? `focus:${selector}` : "all"}
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            /* No onlyRenderVisibleElements: viewport virtualization culls
               nodes mid-drag (the whole graph "disappears" while dragging),
               and a few hundred nodes render fine without it. */
            nodesDraggable
            /* No auto-pan while dragging nodes: in the sandboxed WKWebView
               iframe the pointerup can be lost at the frame boundary, and a
               drag near the pane edge then pans the viewport away forever —
               the graph "disappears". */
            autoPanOnNodeDrag={false}
            /* Default minZoom (0.5) can't fit a 100-source column — fitView
               clamps and shows only a slice of the columns. */
            minZoom={0.05}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            /* Double-click means "open in editor" here, not zoom. */
            zoomOnDoubleClick={false}
            onPaneClick={() => setSelected(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <ZonesOverlay
              nodes={graph?.nodes ?? []}
              positions={positioned}
              styles={areaStyles}
              areasVisible={areasVisible}
              shape={zoneShape}
            />
            {showCallouts && (
              <CalloutOverlay
                nodes={graph?.nodes ?? []}
                positions={positioned}
                dimmed={selected != null || spotArea != null}
              />
            )}
          </ReactFlow>
          </ViewContext.Provider>
        </div>
      </div>
      {selectedNode && (
        <aside
          role="complementary"
          aria-label="node details"
          style={{
            width: panelW, flexShrink: 0, position: "relative",
            borderLeft: "1px solid #334155",
            background: "#111827", color: "#e5e7eb", padding: 16,
            overflowY: "auto",
          }}
        >
          {/* Drag the left edge to resize the panel. */}
          <div
            role="separator"
            aria-label="Resize details"
            aria-orientation="vertical"
            onPointerDown={startPanelResize}
            style={{
              position: "absolute", left: 0, top: 0, bottom: 0, width: 6,
              cursor: "ew-resize",
            }}
          />
          <button
            onClick={() => setSelected(null)}
            style={{ float: "right", background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }}
            aria-label="close details"
          >
            ×
          </button>
          <h3 style={{ marginTop: 0, wordBreak: "break-word" }}>{selectedNode.name}</h3>
          <dl style={{ fontSize: 13, lineHeight: 1.6 }}>
            <dt style={{ color: "#94a3b8" }}>type</dt>
            <dd style={{ margin: 0 }}>{selectedNode.resource_type}</dd>
            <dt style={{ color: "#94a3b8", marginTop: 8 }}>materialization</dt>
            <dd style={{ margin: 0 }}>{selectedNode.materialized || "—"}</dd>
            <dt style={{ color: "#94a3b8", marginTop: 8 }}>path</dt>
            <dd style={{ margin: 0, wordBreak: "break-all" }}>{selectedNode.path}</dd>

            <dt style={{ color: "#94a3b8", marginTop: 8 }}>tags</dt>
            <dd style={{ margin: 0 }}>
              {selectedNode.tags?.length
                ? selectedNode.tags.map((t) => (
                    <span key={t} style={{
                      display: "inline-block", margin: "2px 4px 2px 0", padding: "1px 8px",
                      borderRadius: 10, background: "#1f2937", border: "1px solid #334155", fontSize: 12,
                    }}>{t}</span>))
                : "—"}
            </dd>

            <dt style={{ color: "#94a3b8", marginTop: 8 }}>description</dt>
            <dd style={{ margin: 0 }}>
              {editable ? (
                <>
                  <textarea
                    aria-label="description" value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", height: descH, background: "#0b1220",
                      color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6, padding: 6,
                      fontFamily: "inherit", fontSize: 13, resize: "none", display: "block" }}
                  />
                  <div
                    role="separator" aria-label="Resize description" aria-orientation="horizontal"
                    onPointerDown={startBoxResize(setDescH, descH)}
                    style={{ height: 10, cursor: "ns-resize", display: "flex",
                      alignItems: "center", justifyContent: "center" }}
                  >
                    <div style={{ width: 28, height: 3, borderRadius: 2, background: "#334155" }} />
                  </div>
                </>
              ) : (selectedNode.description || "—")}
            </dd>

            {editable && (
              <>
                <dt style={{ color: "#94a3b8", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  gist
                  <button
                    aria-label="generate gist with AI" title="Generate gist with AI"
                    onClick={() => void onSparkle()} disabled={gistBusy}
                    style={{ background: "none", border: "none", cursor: gistBusy ? "default" : "pointer",
                      color: gistBusy ? "#64748b" : "#fbbf24", fontSize: 14, padding: 0,
                      display: "inline-flex", alignItems: "center" }}
                  >
                    {gistBusy
                      ? <span aria-hidden style={{ width: 12, height: 12, borderRadius: "50%",
                          border: "2px solid #334155", borderTopColor: "#fbbf24",
                          display: "inline-block", animation: "mnemo-spin 0.7s linear infinite" }} />
                      : "✨"}
                  </button>
                  {gistBusy && <span style={{ color: "#94a3b8", fontSize: 11 }}>generating…</span>}
                </dt>
                <dd style={{ margin: 0 }}>
                  <textarea
                    aria-label="gist" value={gistDraft}
                    onChange={(e) => setGistDraft(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", height: gistH, background: "#0b1220",
                      color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6, padding: 6,
                      fontFamily: "inherit", fontSize: 13, resize: "none", display: "block" }}
                  />
                  <div
                    role="separator" aria-label="Resize gist" aria-orientation="horizontal"
                    onPointerDown={startBoxResize(setGistH, gistH)}
                    style={{ height: 10, cursor: "ns-resize", display: "flex",
                      alignItems: "center", justifyContent: "center" }}
                  >
                    <div style={{ width: 28, height: 3, borderRadius: 2, background: "#334155" }} />
                  </div>
                </dd>
                <dd style={{ margin: "10px 0 0", display: "flex", gap: 8 }}>
                  <button
                    onClick={() => void onSave()} disabled={!dirty}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155",
                      background: dirty ? "#2563eb" : "#1f2937", color: "#e5e7eb",
                      cursor: dirty ? "pointer" : "default", fontFamily: "inherit", fontSize: 13 }}
                  >Save</button>
                  <button
                    onClick={() => { setDescDraft(selectedNode.description ?? "");
                      setGistDraft(typeof selectedNode.meta?.gist === "string" ? selectedNode.meta.gist : ""); }}
                    disabled={!dirty}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155",
                      background: "#111827", color: "#94a3b8",
                      cursor: dirty ? "pointer" : "default", fontFamily: "inherit", fontSize: 13 }}
                  >Revert</button>
                </dd>
                {saveErr && <dd style={{ margin: "8px 0 0", color: "#fca5a5", fontSize: 12 }}>{saveErr}</dd>}
              </>
            )}

            <dt style={{ color: "#94a3b8", marginTop: 8 }}>tests</dt>
            <dd style={{ margin: 0, wordBreak: "break-word" }}>
              {selectedNode.tests?.length
                ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {selectedNode.tests.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                )
                : "—"}
            </dd>
          </dl>
          <style>{"@keyframes mnemo-spin{to{transform:rotate(360deg)}}"}</style>
          {toast && (
            <div
              role="status"
              style={{
                position: "absolute", left: 16, right: 16, bottom: 16,
                background: "#065f46", color: "#d1fae5", border: "1px solid #10b981",
                borderRadius: 6, padding: "8px 12px", fontSize: 12, textAlign: "center",
                boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
              }}
            >{toast}</div>
          )}
        </aside>
      )}
    </div>
  );
}
