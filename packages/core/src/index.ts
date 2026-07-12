import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { setBridge, type Bridge } from "./bridge";

export { default as App } from "./App";
export { setBridge, type Bridge } from "./bridge";
export type { Graph, GraphNode, GraphEdge } from "./graphTypes";

/** Inject a host bridge and mount the DAG into `el`. */
export function mountApp(
  el: HTMLElement,
  opts: { bridge: Bridge; projectPath: string; initialSelector?: string },
): void {
  setBridge(opts.bridge);
  // Plain-JS render (no JSX) so this file can stay a .ts module, matching
  // package.json's "main": "src/index.ts" — JSX syntax requires .tsx.
  createRoot(el).render(
    createElement(
      StrictMode,
      null,
      createElement(App, { projectPath: opts.projectPath, initialSelector: opts.initialSelector ?? "" }),
    ),
  );
}
