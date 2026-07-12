import { createContext } from "react";

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
  /** Live search term (lowercased, "" = off): nodes whose name contains it
   * highlight the matching text and get an amber ring. */
  search: string;
}

export const ViewContext = createContext<ViewState>({
  selected: null,
  active: null,
  up: new Set(),
  down: new Set(),
  matched: null,
  search: "",
});
