import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { setBridge, type Bridge } from "./bridge";

export { default as App } from "./App";
export { setBridge, type Bridge } from "./bridge";
export type { Graph, GraphNode, GraphEdge } from "./graphTypes";
export type { Status, RunEvent } from "./runStatus";
export { parseManifest } from "./manifest";
export { extractColumnLineage } from "./columnLineage";
export type { ColumnLineagePayload, ColumnLineageNode, ColumnLineageEdge, ColumnEntry, ColumnLineageInspection } from "./columnLineage";

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 16, background: "#0b1220", color: "#fca5a5", minHeight: "100vh", font: "12px/1.5 ui-monospace, Menlo, monospace", whiteSpace: "pre-wrap" }}>
        <b>dbt Open Lineage crashed</b>{"\n\n"}
        {String(this.state.err?.stack || this.state.err)}
      </div>
    );
  }
}

/** Inject a host bridge and mount the DAG into `el`. */
export function mountApp(
  el: HTMLElement,
  opts: { bridge: Bridge; projectPath: string; initialSelector?: string; readOnly?: boolean; canRun?: boolean },
): void {
  setBridge(opts.bridge);
  createRoot(el).render(
    <StrictMode>
      <Boundary>
        <App projectPath={opts.projectPath} initialSelector={opts.initialSelector ?? ""} readOnly={opts.readOnly ?? false} canRun={opts.canRun ?? false} />
      </Boundary>
    </StrictMode>,
  );
}
