import { createContext } from "react";
import type { RunDisplayStatus } from "./runStatus";

/** Selection/emphasis state consumed by DagNode via context, NOT via node
 * data: styling changes (click a node, type a selector) then re-render the
 * node components without ever producing new node OBJECTS — during drags
 * React Flow must see stable node identities except the node being dragged,
 * or it re-syncs the whole store every frame (which breaks measurement in
 * WKWebView and blanks the graph). */
export interface ViewState {
  selected: string | null;
  /** The model whose file is OPEN in the IDE editor — the focus of the
   * pushed lineage. Rendered with a persistent emphasis so it's obvious
   * which node in the cone is the model you're looking at, independent of
   * any node you click (`selected`). null in the standalone window. */
  active: string | null;
  up: Set<string>;
  down: Set<string>;
  /** When set (focus off), nodes NOT in this set render dimmed. */
  matched: Set<string> | null;
  /** When set (an area is spotlighted), nodes NOT in this set render dimmed. */
  spotlight: Set<string> | null;
  /** When set (a label filter is active), nodes NOT in this set render dimmed. */
  filtered: Set<string> | null;
  /** Live search term (lowercased, "" = off): nodes whose name contains it
   * highlight the matching text and get an amber ring. */
  search: string;
  /** Ids the user has starred (personal, localStorage). Drives the ★ badge. */
  favorites: Set<string>;
  /** Toggle a node's favorite state (persists to localStorage). */
  onToggleFavorite: (id: string) => void;
  /** Per-node run/build/test outcome for the in-flight or most recent run.
   * null when no run has happened yet; absence of a node's id from the map
   * (with the map non-null) means that node is idle (not yet reached, or a
   * fresh run cleared prior results). "queued" is a client-only optimistic
   * state seeded at run start for every node the run's selector includes,
   * before dbt's own START event for that node arrives. Drives the marble. */
  runStatus: Map<string, RunDisplayStatus> | null;
  // ── Column-lineage interaction state (all optional; only set in column mode).
  /** The picked column the user clicked; only its trace animates. */
  selectedColumn?: import("./columnTrace").ColEndpoint | null;
  /** Endpoint keys on the selected column's trace — every node highlights its
   * participating picked rows so the multi-hop path reads as one line.
   * ReadonlySet (not Set) so the shared EMPTY_KEYS constant and traceColumn's
   * Set both assign cleanly. */
  columnTrace?: ReadonlySet<string>;
  /** Endpoint keys of picked columns whose name matches the search query. */
  columnSearchHits?: ReadonlySet<string>;
  /** Node id OR endpoint key of the current Prev/Next target (stronger ring). */
  currentHit?: string | null;
  /** Click a picked column row → select it (toggles). */
  onSelectColumn?: (node: string, column: string) => void;
  /** Add a column as a row on its node (from the in-node dropdown or the panel). */
  onPickColumn?: (node: string, column: string) => void;
  /** Remove a picked column row. */
  onUnpickColumn?: (node: string, column: string) => void;
}

export const ViewContext = createContext<ViewState>({
  selected: null,
  active: null,
  up: new Set(),
  down: new Set(),
  matched: null,
  spotlight: null,
  filtered: null,
  search: "",
  favorites: new Set(),
  onToggleFavorite: () => {},
  runStatus: null,
});
