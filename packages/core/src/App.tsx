import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ReactFlow, Background, Controls, applyNodeChanges,
  type Node, type Edge, type NodeMouseHandler, type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng, toSvg } from "html-to-image";
import type { Graph, GraphNode } from "./graphTypes";
import { invoke, onContext, onRunEvent, saveExport, openInIde } from "./bridge";
import { layoutGraph } from "./layout";
import { resolveSelector, focalName, buildSelector } from "./selector";
import { hasFullRefreshFlag, stripFullRefreshFlag } from "./runFlags";
import type { RunDisplayStatus, RunEvent } from "./runStatus";
import { nodeTypes, isDimmed, type DagNodeData } from "./nodes";
import { ViewContext, type ViewState } from "./viewContext";
import { exportScope, toCsv, toMermaid, b64encode } from "./export";
import { targetYamlPath, upsertModelDoc } from "./yamlEdit";
import { parseAnnotations, setSidecarColor, SIDECAR_PATH, EMPTY_ANNOTATIONS, type Annotations } from "./annotations";
import { nodeAreas, nodeLabels } from "./zones";
import { readMeta } from "./meta";
import type { ColumnLineagePayload } from "./columnLineage";
import { estimateColumnNodeSize, traceColumn, columnTraceEdges, endpointKey, type ColEndpoint } from "./columnTrace";
import { ZonesOverlay } from "./ZonesOverlay";
import { CalloutOverlay, estimateCalloutHeight } from "./CalloutOverlay";
import { AreaControl } from "./AreaControl";
import { LabelBar } from "./LabelBar";
import { resolveStyles } from "./styles";
import { loadFavorites, saveFavorites } from "./favorites";
import { computeFiltered } from "./filters";
import { TagChips } from "./TagChips";
import { DrawLayer, type DrawMode } from "./DrawLayer";
import { type Stroke } from "./drawing";

interface Props { projectPath: string; initialSelector?: string; debounceMs?: number; readOnly?: boolean; canRun?: boolean }

// The sandboxed iframe gets no font from the host app — without this the DAG
// renders in the user agent's default serif (Times). System UI sans, like the
// IDE's workbench font.
const FONT_UI =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

// Small-caps, letter-spaced section label — the mockup's structural device.
// Names a control group (Draw / Filter) so the toolbar reads as sections, not
// one cramped row.
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: "0.09em",
  textTransform: "uppercase", color: "#94a3b8", whiteSpace: "nowrap",
};

// Bordered-pill toggle (Callouts): keeps Callouts' native checkbox (label
// association + tests) inside the mockup's quiet chip frame.
const TOGGLE_PILL: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer",
  userSelect: "none", background: "#0b1220", border: "1px solid #334155",
  borderRadius: 7, padding: "6px 10px", fontSize: 12, color: "#e5e7eb",
};

/** Order-sensitive string-list equality — for the panel's dirty check. */
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Stable empty style map — tags carry no custom name/colour, so their
 * ChipEditor renders keys verbatim with the fallback grey dot. */
const EMPTY_STYLES: Map<string, { name: string; color: string }> = new Map();

/** Shared empty endpoint-key set — stable identity for the no-selection case. */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

/** A quiet ⓘ affordance next to an editor header. Focusable and labelled;
 * reveals a short explanation on hover, focus, or click. No native `title`
 * attribute — it would double up with the styled tooltip below. */
function InfoIcon({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button" aria-label={label}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 15, height: 15, borderRadius: "50%", border: "1px solid #334155",
          background: "#0b1220", color: "#94a3b8", fontStyle: "italic",
          fontWeight: 600, fontSize: 10, lineHeight: 1, cursor: "help", padding: 0,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}
      >i</button>
      {open && (
        <span role="tooltip" style={{
          position: "absolute", top: "135%", left: 0, zIndex: 30, width: 250, maxWidth: "80vw",
          background: "#0b1220", border: "1px solid #334155", borderRadius: 6,
          padding: "7px 9px", fontSize: 11, lineHeight: 1.45, color: "#cbd5e1",
          fontWeight: 400, textTransform: "none", letterSpacing: 0,
          // Preserve the YAML example's newlines + indentation.
          whiteSpace: "pre-wrap",
          boxShadow: "0 10px 24px rgba(0,0,0,0.5)",
        }}>{text}</span>
      )}
    </span>
  );
}

/** Membership editor for one list (subject areas OR labels): the current
 * values as removable color-dot chips, plus a typed/pick-from-datalist input
 * to add one. Matches the panel's dark chip styling; assignment is buffered
 * (nothing hits disk until the panel's Save). */
function ChipEditor({
  title, info, values, onChange, styles, allKeys, addLabel, listId,
}: {
  title: string; info: string; values: string[];
  onChange: (next: string[]) => void;
  styles: Map<string, { name: string; color: string }>;
  allKeys: string[]; addLabel: string; listId: string;
}) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const addValue = (v: string) => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setInput("");
  };
  const display = (k: string) => styles.get(k)?.name ?? k;
  const q = input.trim().toLowerCase();
  const suggestions = allKeys
    .filter((k) => !values.includes(k) && (q === "" || k.toLowerCase().includes(q) || display(k).toLowerCase().includes(q)))
    .slice(0, 8);
  return (
    <>
      <dt style={{ color: "#94a3b8", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
        {title}
        <InfoIcon label={`About ${title}`} text={info} />
      </dt>
      <dd style={{ margin: 0 }}>
        {values.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {values.map((v) => (
              <span key={v} style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 6px 3px 8px",
                borderRadius: 20, background: "#1f2937", border: "1px solid #334155",
                fontSize: 12, color: "#e5e7eb",
              }}>
                <span aria-hidden style={{
                  width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: styles.get(v)?.color ?? "#64748b",
                }} />
                {display(v)}
                <button
                  type="button" aria-label={`Remove ${display(v)}`}
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  style={{
                    background: "none", border: "none", color: "#94a3b8", cursor: "pointer",
                    fontSize: 14, lineHeight: 1, padding: "0 1px",
                  }}
                >×</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ position: "relative", display: "flex", gap: 6 }}>
          <input
            value={input} placeholder={addLabel} aria-label={addLabel}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addValue(input); } }}
            style={{
              flex: 1, minWidth: 0, padding: "5px 9px", borderRadius: 7,
              border: "1px solid #334155", background: "#0b1220", color: "#e5e7eb",
              fontFamily: "inherit", fontSize: 12,
            }}
          />
          <button
            type="button" onClick={() => addValue(input)}
            style={{
              padding: "5px 11px", borderRadius: 7, border: "1px solid #334155",
              background: "#111827", color: "#e5e7eb", cursor: "pointer",
              fontFamily: "inherit", fontSize: 12,
            }}
          >Add</button>
          {/* Custom (themed) suggestions — the native <datalist> popup renders
              unreadably in the dark WKWebView. */}
          {focused && suggestions.length > 0 && (
            <div role="listbox" style={{
              position: "absolute", left: 0, top: "calc(100% + 4px)", zIndex: 30,
              minWidth: 180, maxHeight: 200, overflowY: "auto",
              background: "#111827", border: "1px solid #334155", borderRadius: 7, padding: 4,
              boxShadow: "0 12px 28px rgba(0,0,0,0.5)",
            }}>
              {suggestions.map((k) => (
                <button
                  key={k} type="button" role="option"
                  onMouseDown={(e) => { e.preventDefault(); addValue(k); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    background: "none", border: "none", color: "#e5e7eb", cursor: "pointer",
                    fontFamily: "inherit", fontSize: 13, padding: "6px 8px", borderRadius: 6,
                  }}
                >
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                    background: styles.get(k)?.color ?? "#64748b" }} />
                  {display(k)}
                </button>
              ))}
            </div>
          )}
        </div>
      </dd>
    </>
  );
}

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

export default function App({ projectPath, initialSelector = "", debounceMs = 150, readOnly = false, canRun = false }: Props) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An initial selector (from the IDE's Lineage panel) starts committed AND
  // focused: the panel shows just the model's lineage, not the whole DAG.
  const [raw, setRaw] = useState(initialSelector);
  const [selector, setSelector] = useState(initialSelector);
  const [focus, setFocus] = useState(initialSelector !== "");

  // "Show whole project" mode: only reachable via the blank-Enter confirm
  // modal below, never a silent default. Resets whenever the user starts
  // typing again (raw changes away from blank) — the next blank-Enter
  // always re-prompts, no session memory of a prior confirmation.
  const [showAll, setShowAll] = useState(false);
  const [confirmShowAll, setConfirmShowAll] = useState(false);
  useEffect(() => {
    if (raw.trim() !== "") setShowAll(false);
  }, [raw]);

  // Apply Filter / Restore: a one-shot snapshot (not a live toggle) of the
  // currently emphasized node ids, used to physically strip everything else
  // off the DAG. `null` = no pruning (default, unaffected). Set by clicking
  // Apply Filter; cleared by clicking Restore, or automatically whenever the
  // committed selector/lineage changes (see the reset effect below).
  const [pruned, setPruned] = useState<Set<string> | null>(null);
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
  const [grainH, setGrainH] = useState(72); // grain box height, drag handle below

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
  // A fresh compile / manifest reload invalidates any picked-column selection.
  useEffect(() => { setSelectedColumn(null); }, [graph]);

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

  const [areaFilter, setAreaFilter] = useState<Set<string>>(new Set());
  const onToggleArea = (area: string) =>
    setAreaFilter((prev) => {
      const next = new Set(prev);
      next.has(area) ? next.delete(area) : next.add(area);
      return next;
    });
  const [showCallouts, setShowCallouts] = useState(false);
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  useEffect(() => { setFavorites(loadFavorites(projectPath)); }, [projectPath]);
  const onToggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveFavorites(projectPath, next);
      return next;
    });
  }, [projectPath]);

  const [favActive, setFavActive] = useState(false);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const onToggleTag = (tag: string) =>
    setTagFilter((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });

  const allTags = useMemo(() => {
    const set = new Set<string>();
    if (graph) for (const n of graph.nodes) for (const t of n.tags ?? []) set.add(t);
    return [...set].sort();
  }, [graph]);

  // Which zones are drawn follows the subject-area filter: filter on some areas
  // → only their zones show (and the DAG narrows to their members); none → show
  // every area's zone.
  const areasVisible = useMemo(
    () => (areaFilter.size ? new Set(areaFilter) : new Set(allAreas)),
    [areaFilter, allAreas],
  );

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

  // Detected from the COMMITTED selector (mirrors hasSeed's dependency
  // style below), not the per-keystroke raw text — avoids recomputing
  // before the debounce settles. The token is stripped before the text
  // reaches resolveSelector; it isn't real dbt selector syntax and would
  // otherwise silently match nothing as an unrecognized term.
  const hasFullRefresh = useMemo(() => hasFullRefreshFlag(selector), [selector]);
  const cleanedSelector = useMemo(() => stripFullRefreshFlag(selector), [selector]);

  // debounce selector input → no resolve per keystroke
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSelector(raw), debounceMs);
    return () => clearTimeout(timer.current);
  }, [raw, debounceMs]);

  // Regex mode is a pure mode switch: when on, the box's text is a
  // case-insensitive regex matched against model NAMES, and dbt selector
  // syntax (+hops, tag:, --exclude) does not apply at all. `regexError`
  // is derived in the SAME memo as `matched` (never a setState call inside
  // a useMemo body — that risks "cannot update state during render") so an
  // invalid pattern surfaces as part of one atomic derived value.
  const [regexMode, setRegexMode] = useState(false);
  const [columnLineageMode, setColumnLineageMode] = useState(false);
  const [columnLineage, setColumnLineage] = useState<ColumnLineagePayload | null>(null);
  const [columnLineageBusy, setColumnLineageBusy] = useState(false);
  const [columnLineageErr, setColumnLineageErr] = useState<string | null>(null);

  // Which columns are rendered as rows on each node (user-controlled). Picking
  // changes node data → one rebuild + relayout (accepted, like toggling
  // callouts). Empty in normal mode → nodeSizes empty → identical layout.
  const [pickedColumns, setPickedColumns] = useState<Map<string, Set<string>>>(new Map());
  const onPickColumn = useCallback((node: string, column: string) => {
    setPickedColumns((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(node) ?? []);
      set.add(column);
      next.set(node, set);
      return next;
    });
  }, []);
  const onUnpickColumn = useCallback((node: string, column: string) => {
    setPickedColumns((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(node) ?? []);
      set.delete(column);
      if (set.size) next.set(node, set); else next.delete(node);
      return next;
    });
  }, []);
  // The clicked column whose trace animates (interaction → ViewContext, no relayout).
  const [selectedColumn, setSelectedColumn] = useState<ColEndpoint | null>(null);
  const onSelectColumn = useCallback((node: string, column: string) => {
    setSelectedColumn((prev) =>
      prev && prev.node === node && prev.column === column ? null : { node, column });
  }, []);

  // An empty selector matches NOTHING (not everything) UNLESS the user has
  // explicitly confirmed "show all" via the blank-Enter modal below —
  // resolveSelector's own "empty = all" convention still holds for other
  // callers; we gate it here. Mode-independent: an empty box behaves the
  // same whether regex mode is on or off.
  const { matched, regexError } = useMemo(() => {
    if (!graph) return { matched: new Set<string>(), regexError: null as string | null };
    if (!cleanedSelector.trim()) {
      if (showAll) return { matched: new Set(graph.nodes.map((n) => n.id)), regexError: null };
      return { matched: new Set<string>(), regexError: null };
    }
    if (regexMode) {
      try {
        const re = new RegExp(cleanedSelector, "i");
        return {
          matched: new Set(graph.nodes.filter((n) => re.test(n.name)).map((n) => n.id)),
          regexError: null,
        };
      } catch {
        return { matched: new Set<string>(), regexError: "invalid pattern" };
      }
    }
    return { matched: resolveSelector(graph, cleanedSelector), regexError: null };
  }, [graph, cleanedSelector, showAll, regexMode]);

  // Unfiltered view: layout runs ONCE per graph (positions keyed on graph
  // identity only — typing a selector just dims, never re-lays-out). With the
  // filter on, lay out the visible SUBGRAPH instead, so the remaining nodes
  // sit compactly together rather than keeping their full-graph positions.
  const visibleGraph = useMemo(() => {
    if (!graph) return graph;
    // Empty selector → empty DAG (no default "show every model"), unless
    // the user confirmed "show all" via the blank-Enter modal.
    if (!cleanedSelector.trim() && !showAll) return { nodes: [], edges: [] };
    // Fast path preserved exactly as before when nothing further narrows
    // the view — same object identity as `graph`, so layout reuses
    // full-graph positions instead of re-computing.
    if (!focus && pruned === null) return graph;
    const passesFocus = (id: string) => !focus || matched.has(id);
    const passesPrune = (id: string) => pruned === null || pruned.has(id);
    return {
      nodes: graph.nodes.filter((n) => passesFocus(n.id) && passesPrune(n.id)),
      edges: graph.edges.filter((e) =>
        passesFocus(e.from) && passesFocus(e.to) && passesPrune(e.from) && passesPrune(e.to)),
    };
  }, [graph, focus, matched, cleanedSelector, showAll, pruned]);
  // Reserve layout space for callout bubbles: when callouts are on, a model
  // that actually has a callout gets extra height in dagre (see layout.ts), so
  // its bubble no longer overlaps the row above. Empty when callouts are off →
  // layout is byte-identical to the no-callout case. NOTE: toggling callouts
  // changes this map → re-layout → nodes shift (accepted tradeoff).
  const calloutHeights = useMemo(() => {
    const m = new Map<string, number>();
    // Mirror CalloutOverlay's gistOf exactly (readMeta, namespaced-first) —
    // this memo's whole purpose is predicting what gistOf will render, so a
    // node with nested-only meta must reserve space too, not just flat.
    if (showCallouts && graph) for (const n of graph.nodes) {
      const g = readMeta(n.meta, "gist"), c = readMeta(n.meta, "callout");
      if (typeof g === "string" && g.trim() && c) m.set(n.id, estimateCalloutHeight(g));
    }
    return m;
  }, [graph, showCallouts]);
  // Per-node box size in column mode: header + pick bar + one row per
  // MANUALLY picked column. Intentionally excludes the live columnTrace (an
  // auto-revealed row from selecting a column) — selecting must trigger ZERO
  // relayout (Invariant 3), so an auto-row is not reserved height here; the
  // node can render slightly taller than its slot (accepted v1 visual
  // crowding — see scope-decision 1). Empty unless column mode is on with
  // data loaded → layoutGraph falls back to NODE_W×NODE_H and produces
  // byte-identical output to today.
  const nodeSizes = useMemo(() => {
    const m = new Map<string, { w: number; h: number }>();
    if (!(columnLineageMode && columnLineage) || !graph) return m;
    for (const n of graph.nodes) {
      m.set(n.id, estimateColumnNodeSize([...(pickedColumns.get(n.id) ?? [])]));
    }
    return m;
  }, [columnLineageMode, columnLineage, pickedColumns, graph]);
  const positioned = useMemo(
    () => (visibleGraph ? layoutGraph(visibleGraph, calloutHeights, nodeSizes) : new Map()),
    [visibleGraph, calloutHeights, nodeSizes],
  );

  const [drawMode, setDrawMode] = useState<DrawMode>("off");
  const [penColor, setPenColor] = useState("#f8fafc");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  // Ink is pinned in flow-space; when the layout changes (filter/selector/graph
  // change → new `positioned`), the nodes move out from under it, so clear it.
  useEffect(() => { setStrokes([]); }, [positioned]);

  // While drawing, hold Space to temporarily pan (like design tools). Only
  // active in draw mode; ignored while typing so Space still types a space.
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    if (drawMode === "off") { setSpaceHeld(false); return; }
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return; // let text inputs keep Space / Cmd-Z
      if (e.code === "Space") { e.preventDefault(); setSpaceHeld(true); }
      // Cmd/Ctrl+Z → undo the last pen stroke.
      else if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        setStrokes((prev) => prev.slice(0, -1));
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      setSpaceHeld(false);
    };
  }, [drawMode]);

  // Nodes live in STATE, keyed to the layout they were built from. Drags are
  // applied with applyNodeChanges, which preserves the identity of every node
  // object except the one being dragged — rebuilding the whole array per drag
  // frame forces React Flow to re-sync its entire store at 60fps, which
  // breaks node measurement in WKWebView and blanks the graph. A layout
  // change (new graph, selector commit, focus toggle) swaps in fresh
  // positions DURING RENDER, so a remount + fitView never sees stale ones.
  // Selection/dim styling rides in ViewContext, not node data (see nodes.tsx).
  const buildNodes = (): Node<DagNodeData>[] =>
    // Empty selector → render nothing (the DAG starts blank; no default
    // "show every model"), unless the user confirmed "show all". Otherwise
    // focus filters to the matched set, and without focus every node
    // renders (dimming handles emphasis). `pruned` (Apply Filter) narrows
    // further on top of either case.
    !graph || (!cleanedSelector.trim() && !showAll) ? [] : graph.nodes
      .filter((n) => (focus ? matched.has(n.id) : true))
      .filter((n) => pruned === null || pruned.has(n.id))
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
          // Column mode: PRESENT (even if []) ⇒ DagNode renders the column body.
          ...(columnLineageMode && columnLineage
            ? {
                columns: [...(pickedColumns.get(n.id) ?? [])].map((name) => ({
                  name,
                  hasLineage: columnLineage.nodes[n.id]?.columns[name]?.hasLineage ?? false,
                })),
                allColumns: Object.values(columnLineage.nodes[n.id]?.columns ?? {}).map((c) => ({
                  name: c.columnName,
                  hasLineage: c.hasLineage,
                })),
                width: nodeSizes.get(n.id)?.w,
                height: nodeSizes.get(n.id)?.h,
              }
            : {}),
        },
      }));
  // Rebuild the node array when the layout OR the resolved label styles change
  // (label colors live in node data). A drag never changes either, so this
  // never rebuilds mid-drag — preserving node identity for React Flow.
  const nodeBuildKey = useMemo(
    () => ({ positioned, labelStyles, pickedColumns, columnLineageMode, columnLineage }),
    [positioned, labelStyles, pickedColumns, columnLineageMode, columnLineage],
  );
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

  // Live node positions (reflect hand-drags) for node-anchored overlays like
  // callouts, so a bubble tracks its node instead of staying at the pristine
  // layout spot.
  const livePositions = useMemo(
    () => new Map(rfNodes.map((n) => [n.id, n.position] as const)),
    [rfNodes],
  );

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
  const [grainDraft, setGrainDraft] = useState("");
  const [calloutDraft, setCalloutDraft] = useState(false); // show gist as a DAG callout
  // Membership drafts: which subject areas / labels / tags this model belongs to.
  const [areasDraft, setAreasDraft] = useState<string[]>([]);
  const [labelsDraft, setLabelsDraft] = useState<string[]>([]);
  const [tagsDraft, setTagsDraft] = useState<string[]>([]);
  const [editingCallout, setEditingCallout] = useState(false); // inline-editing a callout bubble
  const [gistBusy, setGistBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null); // transient success pill
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };
  // Separate from `toast` above: that one only renders inside the details
  // sidebar (visible only when a node is selected), but a run typically
  // starts/ends with nothing selected — this one is anchored to the DAG
  // canvas itself instead, so it's visible either way.
  const [runToast, setRunToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const runToastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashRunToast = (msg: string, ok: boolean) => {
    setRunToast({ msg, ok });
    clearTimeout(runToastTimer.current);
    runToastTimer.current = setTimeout(() => setRunToast(null), 2500);
  };
  useEffect(() => {
    setDescDraft(selectedNode?.description ?? "");
    setGistDraft(typeof readMeta(selectedNode?.meta, "gist") === "string" ? (readMeta(selectedNode?.meta, "gist") as string) : "");
    setGrainDraft(typeof readMeta(selectedNode?.meta, "grain") === "string" ? (readMeta(selectedNode?.meta, "grain") as string) : "");
    setCalloutDraft(!!readMeta(selectedNode?.meta, "callout"));
    setAreasDraft(selectedNode ? nodeAreas(selectedNode) : []);
    setLabelsDraft(selectedNode ? nodeLabels(selectedNode) : []);
    setTagsDraft(selectedNode?.tags ?? []);
    setEditingCallout(false);
    setGistBusy(false);
    setSaveErr(null);
    setToast(null);
  }, [selectedNode]);

  // Per-node dbt output, only for lines dbt itself attributes to that node
  // (RunEvent's "log" variant) — never unattributed banner/summary lines.
  // Same three-point reset lifecycle as runStatus: a new run replaces it,
  // Refresh clears it, a lineage change clears it. A run ENDING does not
  // clear it — the last run's logs stay visible until one of those three
  // things happens. Declared here (ahead of the runStatus/runErr cluster
  // below) so `selectedLogs`, derived from it right below, isn't a
  // temporal-dead-zone reference to a not-yet-initialized binding.
  const [runLogs, setRunLogs] = useState<Map<string, string[]> | null>(null);

  const editable = !readOnly && !!selectedNode && selectedNode.resource_type !== "source";
  const selectedLogs = selectedNode ? runLogs?.get(selectedNode.id) : undefined;
  const logsBoxRef = useRef<HTMLDivElement>(null);
  // Auto-scroll the logs box to its latest line while it's open — reads
  // like a tailing terminal for a model that's actively running.
  useEffect(() => {
    if (logsBoxRef.current) logsBoxRef.current.scrollTop = logsBoxRef.current.scrollHeight;
  }, [selectedLogs?.length]);
  // Baseline read via readMeta, consistent with how the drafts themselves are
  // populated above — a flat-only baseline would never match a nested-only
  // draft, leaving `dirty` permanently true for any migrated model.
  const dirty = editable &&
    (descDraft !== (selectedNode!.description ?? "") ||
     gistDraft !== (typeof readMeta(selectedNode!.meta, "gist") === "string" ? (readMeta(selectedNode!.meta, "gist") as string) : "") ||
     grainDraft !== (typeof readMeta(selectedNode!.meta, "grain") === "string" ? (readMeta(selectedNode!.meta, "grain") as string) : "") ||
     calloutDraft !== !!readMeta(selectedNode!.meta, "callout") ||
     !sameList(areasDraft, nodeAreas(selectedNode!)) ||
     !sameList(labelsDraft, nodeLabels(selectedNode!)) ||
     !sameList(tagsDraft, selectedNode!.tags ?? []));

  const onSave = async () => {
    if (!selectedNode) return;
    setSaveErr(null);
    try {
      const path = targetYamlPath(selectedNode);
      const existing = await invoke<string | null>("fs.readText", { path });
      const nextCallout = calloutDraft ? "top" : null;
      // Only persist lists the user actually changed — passing `undefined`
      // leaves the key untouched. Critical for tags: a model's resolved tag
      // list often includes tags INHERITED from dbt_project.yml folder config,
      // and we must not materialize those into the model's own config.tags on
      // an unrelated save (e.g. adding a subject area). Same restraint for
      // areas/labels avoids rewriting keys the save didn't touch.
      const areasArg = sameList(areasDraft, nodeAreas(selectedNode)) ? undefined : areasDraft;
      const labelsArg = sameList(labelsDraft, nodeLabels(selectedNode)) ? undefined : labelsDraft;
      const tagsArg = sameList(tagsDraft, selectedNode.tags ?? []) ? undefined : tagsDraft;
      const text = upsertModelDoc(existing, selectedNode.name, descDraft, gistDraft, grainDraft, nextCallout, areasArg, labelsArg, tagsArg);
      await invoke<boolean>("fs.writeText", { path, text });
      // Optimistic in-memory update: the manifest on disk is stale until the
      // next `dbt compile`, but the panel should reflect the save immediately.
      // meta.callout drives the CalloutOverlay bubble, and subject_areas/labels
      // drive the zones + label stripes, so mirror all of them here — the DAG
      // updates without waiting for a recompile.
      setGraph((g) => g && {
        ...g,
        nodes: g.nodes.map((n) => n.id === selectedNode.id
          ? {
              ...n, description: descDraft, tags: tagsDraft,
              // Write the NESTED shape, matching exactly how upsertModelDoc
              // writes to disk. A flat write here would leave any existing
              // `meta.dbt_open_lineage` sub-object untouched (the `...meta`
              // spread only copies it, doesn't clear it) — and since
              // readMeta prefers nested, the panel would re-read that STALE
              // nested value right after Save, making the save appear to
              // silently revert.
              meta: {
                ...(n.meta ?? {}),
                dbt_open_lineage: {
                  ...((n.meta?.dbt_open_lineage as Record<string, unknown> | undefined) ?? {}),
                  gist: gistDraft, grain: grainDraft, callout: nextCallout ?? undefined,
                  subject_areas: areasDraft, labels: labelsDraft,
                },
              },
            }
          : n),
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

  const onToggleColumnLineage = async () => {
    const next = !columnLineageMode;
    setColumnLineageMode(next);
    if (!next) { setSelectedColumn(null); } // turning off clears the trace
    if (!next || columnLineage) return; // turning off, or data already cached
    setColumnLineageBusy(true); setColumnLineageErr(null);
    try {
      setColumnLineage(await invoke<ColumnLineagePayload>("dbt.columnLineage", {}));
    } catch (e) {
      setColumnLineageErr(String((e as Error).message ?? e));
      setColumnLineageMode(false); // revert — nothing to show
    } finally {
      setColumnLineageBusy(false);
    }
  };

  const onToggleLabel = (label: string) =>
    setLabelFilter((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });

  // A native <input type="color"> fires onChange continuously while the user
  // drags in the picker. Applying every value would (a) rebuild the whole
  // node array on every frame (label colors live in node data, keyed off
  // nodeBuildKey — see Invariant 1) and (b) launch an unserialized
  // read-modify-write per frame that can clobber an in-flight sidecar write.
  // So: debounce to the LATEST {label,color} and serialize the persist —
  // only one read→modify→write in flight at a time, with a newer value that
  // arrives mid-write flushed right after (never lost, never interleaved).
  const labelColorRef = useRef<{ label: string; color: string } | null>(null);
  const labelColorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const labelColorWriting = useRef(false);
  const labelColorPending = useRef(false);

  const persistLabelColor = async () => {
    if (labelColorWriting.current) { labelColorPending.current = true; return; }
    const next = labelColorRef.current;
    if (!next) return;
    labelColorWriting.current = true;
    labelColorPending.current = false;
    try {
      const existing = await invoke<string | null>("fs.readText", { path: SIDECAR_PATH });
      const text = setSidecarColor(existing, "labels", next.label, next.color);
      await invoke<boolean>("fs.writeText", { path: SIDECAR_PATH, text });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      labelColorWriting.current = false;
      if (labelColorPending.current) void persistLabelColor();
    }
  };

  const onLabelColor = (label: string, color: string) => {
    labelColorRef.current = { label, color };
    clearTimeout(labelColorTimer.current);
    labelColorTimer.current = setTimeout(() => {
      const next = labelColorRef.current;
      if (!next) return;
      // Optimistic: update in-memory styles once the drag settles, then
      // persist the sidecar (same shape as before, just coalesced).
      setAnnotations((a) => ({
        ...a,
        labels: { ...a.labels, [next.label]: { name: a.labels[next.label]?.name ?? next.label, color: next.color } },
      }));
      void persistLabelColor();
    }, 150);
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

  const filtered = useMemo(
    () => (graph ? computeFiltered(graph.nodes, { favActive, favorites, areas: areaFilter, labels: labelFilter, tags: tagFilter }) : null),
    [graph, favActive, favorites, areaFilter, labelFilter, tagFilter],
  );

  // The run/build/test button's scope: the INTERSECTION of the
  // selector-matched and category-filtered sets, matching exactly what's
  // visually emphasized (not dimmed) on the DAG — a favorited node outside
  // the current selector's lineage must NOT be included just because one
  // channel is active. `filtered === null` means no category filter is
  // active, and — mirroring isDimmed's own "no restriction" convention —
  // contributes no narrowing in that case (matched alone decides). Only
  // once the selector box is non-blank (or "show all" is confirmed) does
  // this produce anything at all; a blank selector already blanks the
  // whole DAG (see `visibleGraph` above), so Run must have nothing to act
  // on either.
  const activeIds = useMemo(() => {
    if (!cleanedSelector.trim() && !showAll) return new Set<string>();
    const out = new Set<string>();
    for (const id of matched) {
      if (filtered === null || filtered.has(id)) out.add(id);
    }
    return out;
  }, [cleanedSelector, matched, filtered, showAll]);
  const runSelector = useMemo(() => (graph ? buildSelector(activeIds, graph) : ""), [graph, activeIds]);
  // dbt run/test can never build a seed regardless of what's in --select —
  // dbt excludes seeds from those commands by resource type, not selection
  // scope. When the active view includes a seed, the host runs `dbt seed`
  // as a prerequisite before the requested command (see onRun below).
  const hasSeed = useMemo(
    () => (graph ? graph.nodes.some((n) => activeIds.has(n.id) && n.resource_type === "seed") : false),
    [graph, activeIds],
  );

  const [runMenu, setRunMenu] = useState(false);
  const [runActive, setRunActive] = useState<"run" | "build" | "test" | null>(null);
  const [runStatus, setRunStatus] = useState<Map<string, RunDisplayStatus> | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  const runMenuRef = useRef<HTMLDivElement>(null);
  // Click anywhere outside the Run▾ dropdown (or its own toggle button)
  // closes it. mousedown, not click, so a click ON the toggle button still
  // fires its own onClick afterward instead of racing this listener — by
  // the time a "click" would fire, this handler has already run and closed
  // the menu, which would make the toggle immediately reopen it.
  useEffect(() => {
    if (!runMenu) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (runMenuRef.current && e.target instanceof Node && !runMenuRef.current.contains(e.target)) {
        setRunMenu(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [runMenu]);

  // Stale pilot-light colors from a previous lineage view are confusing once
  // the DAG retargets — e.g. double-clicking a node opens it in the IDE,
  // which pushes a new context and changes `selector` (see the onContext
  // effect above). Clear run status whenever the visible lineage changes, not
  // just on an explicit new run.
  useEffect(() => {
    setRunStatus(null);
    setRunErr(null);
    setRunLogs(null);
    setPruned(null);
  }, [selector, regexMode]);

  const onResetStatus = () => {
    setRunStatus(null);
    setRunErr(null);
    setRunLogs(null);
  };

  useEffect(() => onRunEvent((e: RunEvent) => {
    if (e.type === "status") {
      setRunStatus((prev) => {
        const next = new Map(prev ?? []);
        next.set(e.nodeId, e.status);
        return next;
      });
    } else if (e.type === "log") {
      setRunLogs((prev) => {
        const next = new Map(prev ?? []);
        next.set(e.nodeId, [...(next.get(e.nodeId) ?? []), e.line]);
        return next;
      });
    } else {
      setRunActive(null);
      // "Never left spinning": any node still `running` OR `queued` when the
      // run ends (success, failure, or cancel) has no terminal status
      // coming — Cancel sends SIGTERM mid-flight, so an in-flight node's dbt
      // process never emits one, and a cancelled/early-failed run can leave
      // many nodes still queued, never even reached. Flip both to `skipped`
      // so nothing is left spinning OR stuck looking like it's still queued.
      setRunStatus((prev) => {
        if (!prev) return prev;
        const next = new Map(prev);
        let changed = false;
        for (const [id, status] of next) {
          if (status === "running" || status === "queued") { next.set(id, "skipped"); changed = true; }
        }
        return changed ? next : prev;
      });
      if (e.exitCode !== 0) setRunErr(`run failed (exit ${e.exitCode})`);
      // Cancel and a genuine failure both produce this same exitCode!==0
      // shape (SIGTERM'd processes don't distinguish "cancelled" from
      // "crashed") — the toast inherits that ambiguity, same as runErr
      // above. Known, pre-existing limitation; not addressed here.
      flashRunToast(e.exitCode === 0 ? "✓ Run succeeded" : "✗ Run failed", e.exitCode === 0);
    }
  }), []);

  const onRun = async (command: "run" | "build" | "test") => {
    setRunMenu(false);
    if (!runSelector) return;
    setRunErr(null);
    // Seed every node in the run's scope as "queued" immediately, rather
    // than an empty map — otherwise a node waiting its turn looks identical
    // to a node that isn't part of this run at all (both render idle-grey)
    // until dbt's own START event for it arrives, which can be a while for
    // a large selection.
    setRunStatus(new Map([...activeIds].map((id) => [id, "queued" as const])));
    // A second Run (without an intervening Refresh/lineage-change) REPLACES
    // per-node logs, it does not append across runs.
    setRunLogs(new Map());
    setRunActive(command);
    try {
      await invoke<boolean>("dbt.run", { command, selector: runSelector, hasSeed, hasFullRefresh });
    } catch (e) {
      setRunActive(null);
      setRunErr(String((e as Error).message ?? e));
    }
  };

  const onCancelRun = async () => {
    try { await invoke<boolean>("dbt.cancel", {}); }
    catch (e) { setRunErr(String((e as Error).message ?? e)); }
  };

  // Endpoint keys on the selected column's trace — passed to every node so each
  // highlights its participating picked rows (the multi-hop path reads as one).
  const columnTrace = useMemo(
    () => (columnLineage && selectedColumn ? traceColumn(columnLineage, selectedColumn) : EMPTY_KEYS),
    [columnLineage, selectedColumn],
  );

  const view: ViewState = useMemo(() => ({
    selected,
    active: activeId,
    up: lineage.up,
    down: lineage.down,
    // With focus OFF, un-matched nodes dim; with focus ON they're filtered out.
    matched: focus ? null : matched,
    // Subject areas now filter (folded into `filtered`), so nothing drives the
    // separate spotlight channel — it stays a valid but unused dim path.
    spotlight: null,
    filtered,
    search: searchQ,
    favorites,
    onToggleFavorite,
    runStatus,
    selectedColumn,
    columnTrace,
    onSelectColumn,
    onPickColumn,
    onUnpickColumn,
  }), [selected, activeId, lineage, focus, matched, filtered, searchQ, favorites, onToggleFavorite, runStatus, selectedColumn, columnTrace, onSelectColumn, onPickColumn, onUnpickColumn]);

  const dimmedIds = useMemo(
    () => (graph ? new Set(graph.nodes.filter((n) => isDimmed(n.id, view)).map((n) => n.id)) : new Set<string>()),
    [graph, view],
  );

  // Live match count over the nodes actually shown in the DAG.
  const searchHits = useMemo(() => {
    if (!searchQ) return 0;
    return rfNodes.filter((n) => n.data.label.toLowerCase().includes(searchQ)).length;
  }, [rfNodes, searchQ]);

  const rfEdges: Edge[] = useMemo(() => {
    // empty selector → blank DAG, unless "show all" is confirmed
    if (!graph || (!cleanedSelector.trim() && !showAll)) return [];
    const passes = (from: string, to: string) =>
      (!focus || (matched.has(from) && matched.has(to))) &&
      (pruned === null || (pruned.has(from) && pruned.has(to)));

    const modelEdges: Edge[] = graph.edges
      .filter((e) => passes(e.from, e.to))
      .map((e) => {
        const onLineage = edgeOnLineage(selected, lineage, e);
        if (columnLineageMode && columnLineage) {
          // QUIET: model edges stay drawn but never animate or compete with the
          // column trace.
          return {
            id: `${e.from}->${e.to}`, source: e.from, target: e.to, animated: false,
            style: {
              stroke: "#b1b1b7", strokeWidth: 1,
              opacity: (isDimmed(e.from, view) || isDimmed(e.to, view)) ? 0.1 : 0.45,
            },
          };
        }
        return {
          id: `${e.from}->${e.to}`, source: e.from, target: e.to, animated: onLineage,
          style: {
            opacity: hasSel
              ? (onLineage ? 0.95 : 0.06)
              : (isDimmed(e.from, view) || isDimmed(e.to, view)) ? 0.1 : 0.9,
            // Explicit stroke (not just the React Flow CSS class default) so the
            // PNG/SVG export keeps the edges — html-to-image doesn't inline the
            // external stylesheet's stroke, so undefined here = invisible lines.
            stroke: onLineage ? "#e5e7eb" : "#b1b1b7",
            strokeWidth: onLineage ? 2 : 1,
          },
        };
      });

    if (columnLineageMode && columnLineage && selectedColumn) {
      const trace = traceColumn(columnLineage, selectedColumn);
      // Every edge columnTraceEdges returns has BOTH endpoints ON THE TRACE —
      // and DagNode's picked∪trace render union (Task 3) means the trace IS
      // exactly the set of endpoints guaranteed a rendered row (and therefore
      // a Handle) on their node, whether manually picked or auto-revealed.
      // No separate "is it picked" gate needed (flipped from an earlier draft
      // of this plan — see scope-decision 1).
      const traceEdges: Edge[] = columnTraceEdges(columnLineage, trace)
        .filter((e) => passes(e.source, e.target))
        .map((e, i) => ({
          id: `col-${i}-${e.source}.${e.sourceColumn}->${e.target}.${e.targetColumn}`,
          source: e.source, target: e.target,
          sourceHandle: e.sourceColumn, targetHandle: e.targetColumn, // row-to-row
          animated: true,
          style: { stroke: "#38bdf8", strokeWidth: 2 },
        }));
      return [...modelEdges, ...traceEdges];
    }
    return modelEdges;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, matched, focus, selected, lineage, view, cleanedSelector, showAll, pruned, columnLineageMode, columnLineage, selectedColumn]);

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
    <>
      <style>{"@keyframes dol-run-blink{0%,100%{opacity:1}50%{opacity:0.45}}"}</style>
      {confirmShowAll && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="show all models confirmation"
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(2,6,23,0.6)",
          }}
        >
          <div style={{
            background: "#111827", border: "1px solid #334155", borderRadius: 10,
            padding: 20, width: 320, boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e5e7eb", marginBottom: 6 }}>
              Show all {graph?.nodes.length ?? 0} models?
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>
              Large projects may take a moment to render.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setConfirmShowAll(false)}
                style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155",
                  background: "#111827", color: "#94a3b8", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
              >Cancel</button>
              <button
                onClick={() => { setShowAll(true); setFocus(true); setConfirmShowAll(false); }}
                style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155",
                  background: "#2563eb", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
              >Show All</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ width: "100vw", height: "100vh", display: "flex", background: "#0b1220", fontFamily: FONT_UI }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px",
          background: "#111827", borderBottom: "1px solid #334155", minWidth: 0,
        }}>
          {/* Row 0 — query & utilities: the selector box (kept exactly),
              its Focus mode, live search, Export, and Run. flexWrap (matching
              Rows 1/2) so a narrow panel wraps controls onto a new line
              instead of clipping the rightmost one (e.g. Cancel) behind a
              horizontal scrollbar — adding Run/Cancel pushed this row's
              natural width past what a docked/narrow panel can show. minWidth:0
              is required too — without it, this row (a flex item inside the
              column above) defaults to min-width:auto and grows to fit its
              UNWRAPPED content instead of respecting the stretched width,
              so flexWrap alone never gets the chance to trigger. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
            <input
              placeholder="select… e.g. stg_orders+ or tag:mart --exclude config.materialized:view  (Enter shows only the selection)"
              value={raw}
              // macOS "smart dashes" in the WKWebView rewrites a typed `--` to a
              // single em-dash (U+2014), which silently breaks `--exclude`. dbt
              // selectors never contain real em/en-dashes, so normalize any back
              // to `--`. (fontVariantLigatures:none below also stops a purely
              // cosmetic `--`→long-dash ligature.)
              onChange={(e) => setRaw(e.target.value.replace(/[–—]/g, "--"))}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // A blank box offers to show the whole project behind a
                // confirmation, instead of silently doing nothing (today's
                // behavior — a blank selector already blanks the DAG on its
                // own via the debounced sync below, no Enter needed for that).
                if (!raw.trim()) {
                  setConfirmShowAll(true);
                  return;
                }
                // Enter commits the selector: apply it immediately (skip the
                // debounce) and filter the DAG to only the matched nodes.
                setSelector(raw);
                setFocus(true);
              }}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{ flex: 1, minWidth: 200, maxWidth: 380, padding: "6px 10px", borderRadius: 6, border: "1px solid #334155", background: "#111827", color: "#e5e7eb", fontFamily: "inherit", fontVariantLigatures: "none" }}
            />
            <button
              onClick={() => setRegexMode((v) => !v)}
              aria-pressed={regexMode}
              title="Regex mode: match model names by pattern instead of dbt selector syntax"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
                borderRadius: 20, border: `1px solid ${regexMode ? "#3b82f6" : "#334155"}`,
                background: regexMode ? "#16233d" : "#111827",
                color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
              }}
            >.*</button>
            {regexMode && regexError && (
              <span style={{ color: "#fca5a5", fontSize: 12, whiteSpace: "nowrap" }}>{regexError}</span>
            )}
            <button
              onClick={() => setFocus((v) => !v)}
              aria-pressed={focus}
              title="Show only the selector's matched nodes"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
                borderRadius: 20, border: `1px solid ${focus ? "#3b82f6" : "#334155"}`,
                background: focus ? "#16233d" : "#111827",
                color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
              }}
            >Focus</button>
            <button
              onClick={() => void onToggleColumnLineage()}
              aria-pressed={columnLineageMode}
              aria-label="Columns"
              disabled={columnLineageBusy}
              title="Show column-level lineage"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
                borderRadius: 20, border: `1px solid ${columnLineageMode ? "#3b82f6" : "#334155"}`,
                background: columnLineageMode ? "#16233d" : "#111827",
                color: columnLineageBusy ? "#64748b" : "#e5e7eb",
                cursor: columnLineageBusy ? "default" : "pointer",
                fontFamily: "inherit", fontSize: 12,
              }}
            >{columnLineageBusy ? "loading…" : "Columns"}</button>
            {columnLineageErr && (
              <span style={{ color: "#fca5a5", fontSize: 12, whiteSpace: "nowrap" }}>{columnLineageErr}</span>
            )}
            <input
              aria-label="Search nodes"
              placeholder="search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 170, padding: "6px 10px", borderRadius: 7, border: "1px solid #334155", background: "#0b1220", color: "#e5e7eb", fontFamily: "inherit", fontSize: 12 }}
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
                  padding: "6px 10px", borderRadius: 7, border: "1px solid #334155",
                  background: "#111827", color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                }}
              >Export ▾</button>
              {exportMenu && (
                <div
                  role="menu"
                  style={{
                    position: "absolute", right: 0, top: "110%", zIndex: 20, minWidth: 150,
                    background: "#111827", border: "1px solid #334155", borderRadius: 8, overflow: "hidden",
                    boxShadow: "0 16px 34px rgba(0,0,0,0.5)",
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
            {canRun && !readOnly && (
            <>
            <div ref={runMenuRef} style={{ position: "relative" }}>
              {runActive ? (
                <button
                  onClick={() => void onCancelRun()}
                  style={{
                    padding: "6px 10px", borderRadius: 7, border: "1px solid #f87171",
                    background: "#1e293b", color: "#f87171", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                  }}
                >■ Cancel</button>
              ) : (
                <div style={{ display: "flex", borderRadius: 7, border: "1px solid #334155", overflow: "hidden" }}>
                  <button
                    disabled={!runSelector}
                    title={runSelector ? undefined : "no runnable models in current view"}
                    onClick={() => void onRun("run")}
                    style={{
                      padding: "6px 10px", border: "none", borderRight: "1px solid #334155",
                      background: "#111827", color: runSelector ? "#4ade80" : "#475569",
                      cursor: runSelector ? "pointer" : "default", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                    }}
                  >▶ Run</button>
                  <button
                    aria-label="run command menu"
                    aria-haspopup="menu"
                    aria-expanded={runMenu}
                    onClick={() => setRunMenu((v) => !v)}
                    style={{
                      padding: "6px 8px", border: "none", background: "#111827",
                      color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                    }}
                  >▾</button>
                </div>
              )}
              {runMenu && !runActive && (
                <div
                  role="menu"
                  style={{
                    position: "absolute", right: 0, top: "110%", zIndex: 20, minWidth: 110,
                    background: "#111827", border: "1px solid #334155", borderRadius: 8, overflow: "hidden",
                    boxShadow: "0 16px 34px rgba(0,0,0,0.5)",
                  }}
                >
                  {(["run", "build", "test"] as const).map((cmd) => (
                    <button
                      key={cmd}
                      role="menuitem"
                      disabled={!runSelector}
                      onClick={() => void onRun(cmd)}
                      style={{
                        display: "block", width: "100%", textAlign: "left", padding: "7px 12px",
                        background: "none", border: "none", color: runSelector ? "#e5e7eb" : "#475569",
                        cursor: runSelector ? "pointer" : "default", fontFamily: "inherit", fontSize: 13, textTransform: "capitalize",
                      }}
                    >{cmd}</button>
                  ))}
                </div>
              )}
            </div>
            <button
              aria-label="reset run status"
              title="Clear pilot-light status from the last run"
              disabled={!runStatus}
              onClick={onResetStatus}
              style={{
                padding: "6px 9px", borderRadius: 7, border: "1px solid #334155",
                background: "#111827", color: runStatus ? "#e5e7eb" : "#475569",
                cursor: runStatus ? "pointer" : "default", fontFamily: "inherit", fontSize: 12,
              }}
            >↻</button>
            </>
            )}
          </div>

          {/* Row 1 — VIEW: what's drawn over the graph. Callouts, Draw. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={TOGGLE_PILL}>
              <input type="checkbox" checked={showCallouts} onChange={(e) => setShowCallouts(e.target.checked)} /> Callouts
            </label>
            {!readOnly && (
              <>
                <span style={SECTION_LABEL}>Draw</span>
                <div style={{ display: "inline-flex", background: "#0b1220", border: "1px solid #334155", borderRadius: 7, overflow: "hidden" }}>
                  {(["off", "pen", "erase"] as const).map((m, i) => (
                    <button
                      key={m}
                      onClick={() => setDrawMode(m)}
                      style={{
                        padding: "6px 11px", border: "none", borderLeft: i === 0 ? "none" : "1px solid #334155",
                        borderRadius: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                        background: drawMode === m ? "#2563eb" : "transparent",
                        color: drawMode === m ? "#fff" : "#94a3b8",
                      }}
                    >{m === "off" ? "Off" : m === "pen" ? "✎ Pen" : "⌫ Erase"}</button>
                  ))}
                </div>
                {drawMode !== "off" && (
                  <>
                    {["#f8fafc", "#ef4444", "#22d3ee", "#f0abfc", "#fde047"].map((c) => (
                      <button
                        key={c}
                        aria-label={`pen color ${c}`}
                        onClick={() => setPenColor(c)}
                        style={{
                          width: 18, height: 18, borderRadius: "50%", cursor: "pointer",
                          background: c, border: penColor === c ? "2px solid #e5e7eb" : "1px solid #334155",
                          padding: 0,
                        }}
                      />
                    ))}
                    <button
                      onClick={() => setStrokes([])}
                      style={{
                        padding: "6px 11px", borderRadius: 7, border: "1px solid #334155",
                        background: "#111827", color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                      }}
                    >Clear</button>
                  </>
                )}
              </>
            )}
          </div>

          {/* Divider + Row 2 — FILTER: what stays lit vs. dims. */}
          <div style={{ height: 1, background: "#1f2937" }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={SECTION_LABEL}>Filter</span>
            <button
              onClick={() => setFavActive((v) => !v)}
              aria-pressed={favActive}
              title="Show only favorites"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px",
                borderRadius: 20, border: `1px solid ${favActive ? "#3b82f6" : "#334155"}`,
                background: favActive ? "#16233d" : "#111827",
                color: "#e5e7eb", cursor: "pointer", fontFamily: "inherit", fontSize: 12,
              }}
            >
              <span style={{ color: favActive ? "#fbbf24" : "#64748b" }}>★</span> Favorites
            </button>
            <AreaControl
              areas={allAreas}
              styles={areaStyles}
              filter={areaFilter}
              onToggle={onToggleArea}
            />
            <LabelBar
              labels={allLabels}
              styles={labelStyles}
              filter={labelFilter}
              onToggle={onToggleLabel}
              onColor={readOnly ? undefined : (l, c) => void onLabelColor(l, c)}
            />
            <TagChips tags={allTags} filter={tagFilter} onToggle={onToggleTag} />
            {pruned === null ? (
              <button
                onClick={() => setPruned(new Set(activeIds))}
                disabled={!favActive && areaFilter.size === 0 && labelFilter.size === 0 && tagFilter.size === 0}
                title="Remove everything not currently emphasized from the DAG"
                style={{
                  padding: "6px 10px", borderRadius: 7, border: "1px solid #334155",
                  background: "#111827",
                  color: (favActive || areaFilter.size > 0 || labelFilter.size > 0 || tagFilter.size > 0) ? "#e5e7eb" : "#475569",
                  cursor: (favActive || areaFilter.size > 0 || labelFilter.size > 0 || tagFilter.size > 0) ? "pointer" : "default",
                  fontFamily: "inherit", fontSize: 12,
                }}
              >Apply Filter</button>
            ) : (
              <button
                onClick={() => setPruned(null)}
                title="Bring back everything removed by Apply Filter"
                style={{
                  padding: "6px 10px", borderRadius: 7, border: "1px solid #334155",
                  background: "#111827", color: "#e5e7eb", cursor: "pointer",
                  fontFamily: "inherit", fontSize: 12,
                }}
              >Restore</button>
            )}
          </div>
        </div>
        {error && <div style={{ color: "#fca5a5", padding: 8 }}>{error}</div>}
        {exportErr && <div style={{ color: "#fca5a5", padding: 8 }}>export failed: {exportErr}</div>}
        {runErr && <div style={{ color: "#fca5a5", padding: 8 }}>run failed: {runErr}</div>}
        <div style={{ flex: 1, position: "relative" }}>
          {graph && !error && !cleanedSelector.trim() && !showAll && (
            <div
              aria-label="empty selector hint"
              style={{
                position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexDirection: "column", gap: 6, textAlign: "center", padding: 24,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600, color: "#cbd5e1" }}>
                Type a model or dbt selector to view its lineage
              </div>
              <div style={{ fontSize: 12, color: "#64748b", maxWidth: 360 }}>
                e.g. <code style={{ color: "#94a3b8" }}>+my_model+</code> or{" "}
                <code style={{ color: "#94a3b8" }}>stg_orders,dim_account</code>
              </div>
            </div>
          )}
          <ViewContext.Provider value={view}>
          <ReactFlow
            // Remount when the committed filter OR the pruning state
            // changes, so fitView re-frames the (re-laid-out) visible
            // subgraph either way.
            key={`${focus ? `focus:${selector}` : "all"}:${pruned ? "pruned" : "full"}`}
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            /* No onlyRenderVisibleElements: viewport virtualization culls
               nodes mid-drag (the whole graph "disappears" while dragging),
               and a few hundred nodes render fine without it. */
            nodesDraggable={drawMode === "off"}
            panOnDrag={drawMode === "off" || spaceHeld}
            elementsSelectable={drawMode === "off"}
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
            onPaneClick={() => { setSelected(null); setSelectedColumn(null); }}
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
              shape="box"
            />
            {showCallouts && (
              <CalloutOverlay
                nodes={graph?.nodes ?? []}
                positions={livePositions}
                dimmedIds={dimmedIds}
                onSelect={setSelected}
                selectedId={selected}
                editing={editingCallout}
                gistDraft={gistDraft}
                onGistChange={setGistDraft}
                onCommit={async () => { await onSave(); setEditingCallout(false); }}
                onCancelEdit={() => setEditingCallout(false)}
                onBeginEdit={readOnly ? () => {} : (id) => { setSelected(id); setEditingCallout(true); }}
              />
            )}
            <DrawLayer
              mode={drawMode}
              color={penColor}
              width={3}
              strokes={strokes}
              onStrokesChange={setStrokes}
              paused={spaceHeld}
            />
          </ReactFlow>
          </ViewContext.Provider>
          {runToast && (
            <div
              role="status"
              style={{
                position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)",
                background: runToast.ok ? "#065f46" : "#7f1d1d",
                color: runToast.ok ? "#d1fae5" : "#fecaca",
                border: `1px solid ${runToast.ok ? "#10b981" : "#f87171"}`,
                borderRadius: 6, padding: "8px 14px", fontSize: 12, textAlign: "center",
                boxShadow: "0 4px 12px rgba(0,0,0,0.35)", zIndex: 10, whiteSpace: "nowrap",
              }}
            >{runToast.msg}</div>
          )}
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

            {!editable && (
              <>
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
              </>
            )}

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
                  {/* A callout bubble only renders when the model has BOTH a gist
                      and meta.callout; a callout with no gist shows nothing, so
                      the toggle is disabled until a gist exists. */}
                  {(() => {
                    const hasGist = gistDraft.trim() !== "";
                    return (
                      <label
                        style={{
                          display: "flex", alignItems: "center", gap: 8, marginTop: 8,
                          fontSize: 12, color: hasGist ? "#e5e7eb" : "#64748b",
                          cursor: hasGist ? "pointer" : "default",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={calloutDraft && hasGist}
                          disabled={!hasGist}
                          onChange={(e) => setCalloutDraft(e.target.checked)}
                        />
                        Show as callout on the DAG
                        {!hasGist && (
                          <span style={{ color: "#64748b", fontSize: 11 }}>· add a gist first</span>
                        )}
                      </label>
                    );
                  })()}
                </dd>

                <dt style={{ color: "#94a3b8", marginTop: 8 }}>grain</dt>
                <dd style={{ margin: 0 }}>
                  <textarea
                    aria-label="grain" value={grainDraft}
                    onChange={(e) => setGrainDraft(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", height: grainH, background: "#0b1220",
                      color: "#e5e7eb", border: "1px solid #334155", borderRadius: 6, padding: 6,
                      fontFamily: "inherit", fontSize: 13, resize: "none", display: "block" }}
                  />
                  <div
                    role="separator" aria-label="Resize grain" aria-orientation="horizontal"
                    onPointerDown={startBoxResize(setGrainH, grainH)}
                    style={{ height: 10, cursor: "ns-resize", display: "flex",
                      alignItems: "center", justifyContent: "center" }}
                  >
                    <div style={{ width: 28, height: 3, borderRadius: 2, background: "#334155" }} />
                  </div>
                </dd>

                <ChipEditor
                  title="subject areas"
                  info={
                    "Group related models into a named, bounded zone on the DAG (e.g. 'Order Ledger'). A model can belong to several.\n\n" +
                    "The chip text you type IS the key. Give it a display name + colour by adding an entry with that SAME key to lineage.yml at your dbt project root:\n\n" +
                    "subject_areas:\n" +
                    "  order_ledger:\n" +
                    "    name: 'Order Ledger'\n" +
                    "    color: '#8b5cf6'\n\n" +
                    "So a chip typed `order_ledger` shows as 'Order Ledger'. Type a short lowercase key and let name do the capitalizing.\n\n" +
                    "Prefer typing the words directly? Type `Journal Entries` — then quote the key (no name needed):\n\n" +
                    "subject_areas:\n" +
                    "  'Journal Entries':\n" +
                    "    color: '#f59e0b'\n\n" +
                    "No entry → the chip shows the raw key in grey."
                  }
                  values={areasDraft}
                  onChange={setAreasDraft}
                  styles={areaStyles}
                  allKeys={allAreas}
                  addLabel="add subject area…"
                  listId="dol-areas-list"
                />
                <ChipEditor
                  title="labels"
                  info={
                    "Tag models with a coloured stripe + a filter chip (e.g. Core, PII). A model can have several.\n\n" +
                    "The chip text you type IS the key. Give it a display name + colour by adding an entry with that SAME key to lineage.yml at your dbt project root:\n\n" +
                    "labels:\n" +
                    "  core:\n" +
                    "    name: 'Core'\n" +
                    "    color: '#22d3ee'\n\n" +
                    "No entry → the chip shows the raw key in grey."
                  }
                  values={labelsDraft}
                  onChange={setLabelsDraft}
                  styles={labelStyles}
                  allKeys={allLabels}
                  addLabel="add label…"
                  listId="dol-labels-list"
                />
                <ChipEditor
                  title="tags"
                  info={
                    "dbt's native tags (config.tags) — saved straight to your model's YAML. Use them to group or filter models (e.g. nightly, adhoc). A model can have several.\n\n" +
                    "Tags have no custom colour; add one here and it becomes a filter chip in the toolbar."
                  }
                  values={tagsDraft}
                  onChange={setTagsDraft}
                  styles={EMPTY_STYLES}
                  allKeys={allTags}
                  addLabel="add tag…"
                  listId="dol-tags-list"
                />

                <dd style={{ margin: "10px 0 0", display: "flex", gap: 8 }}>
                  <button
                    onClick={() => void onSave()} disabled={!dirty}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #334155",
                      background: dirty ? "#2563eb" : "#1f2937", color: "#e5e7eb",
                      cursor: dirty ? "pointer" : "default", fontFamily: "inherit", fontSize: 13 }}
                  >Save</button>
                  <button
                    onClick={() => { setDescDraft(selectedNode.description ?? "");
                      setGistDraft(typeof readMeta(selectedNode.meta, "gist") === "string" ? (readMeta(selectedNode.meta, "gist") as string) : "");
                      setGrainDraft(typeof readMeta(selectedNode.meta, "grain") === "string" ? (readMeta(selectedNode.meta, "grain") as string) : "");
                      setCalloutDraft(!!readMeta(selectedNode.meta, "callout"));
                      setAreasDraft(nodeAreas(selectedNode));
                      setLabelsDraft(nodeLabels(selectedNode));
                      setTagsDraft(selectedNode.tags ?? []); }}
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

            {columnLineage?.nodes[selectedNode.id] && (
              <>
                <dt style={{ color: "#94a3b8", marginTop: 8 }}>columns</dt>
                <dd style={{ margin: 0 }}>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                    {Object.values(columnLineage.nodes[selectedNode.id].columns).map((c) => {
                      const isPicked = !!pickedColumns.get(selectedNode.id)?.has(c.columnName);
                      const isSel = selectedColumn?.node === selectedNode.id && selectedColumn?.column === c.columnName;
                      return (
                        <li key={c.columnName} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
                          <button
                            aria-label={isPicked ? `unpick column ${c.columnName}` : `pick column ${c.columnName}`}
                            title={isPicked ? "Remove row from node" : "Add row to node"}
                            onClick={() => (isPicked ? onUnpickColumn : onPickColumn)(selectedNode.id, c.columnName)}
                            style={{
                              width: 18, height: 18, flexShrink: 0, borderRadius: 4,
                              border: `1px solid ${isPicked ? "#38bdf8" : "#334155"}`,
                              background: isPicked ? "#16233d" : "#0b1220",
                              color: isPicked ? "#38bdf8" : "#64748b", cursor: "pointer",
                              fontSize: 12, lineHeight: 1, padding: 0,
                            }}
                          >{isPicked ? "✓" : "+"}</button>
                          <button
                            onClick={() => onSelectColumn(selectedNode.id, c.columnName)}
                            style={{
                              flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer",
                              padding: 0, fontFamily: "ui-monospace, monospace", fontSize: 12,
                              color: isSel ? "#38bdf8" : c.hasLineage ? "#e5e7eb" : "#64748b",
                            }}
                          >
                            {c.columnName}
                            {!c.hasLineage && <span style={{ color: "#64748b" }}> (unresolved)</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </>
            )}

            {/* Only rendered once this node has at least one log line —
                an idle/never-run node shows nothing here, keeping the
                common case uncluttered. */}
            {selectedLogs && selectedLogs.length > 0 && (
              <>
                <dt style={{ color: "#94a3b8", marginTop: 8 }}>logs</dt>
                <dd style={{ margin: 0 }}>
                  <div
                    ref={logsBoxRef}
                    style={{
                      height: 150, overflowY: "auto", background: "#0b1220",
                      border: "1px solid #334155", borderRadius: 6, padding: 6,
                      fontFamily: "ui-monospace, monospace", fontSize: 11, lineHeight: 1.5,
                      color: "#cbd5e1", whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}
                  >
                    {selectedLogs.map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                </dd>
              </>
            )}
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
    </>
  );
}
