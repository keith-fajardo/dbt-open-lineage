import { mountApp } from "@dbt-open-lineage/core";
import "@xyflow/react/dist/style.css";
import { createStaticBridge, type StaticPageData } from "./staticBridge";

declare global {
  interface Window { __DOL_STATIC_DATA__?: StaticPageData }
}

// generate.ts (packages/cli/src/generate.ts) embeds this via template.ts
// before this bundle's <script type="module"> tag.
const data = window.__DOL_STATIC_DATA__ ?? { graph: { nodes: [], edges: [] }, sidecarText: null };
if (data.title) document.title = data.title;

mountApp(document.getElementById("root")!, {
  bridge: createStaticBridge(data),
  projectPath: "",
  readOnly: true,
});
